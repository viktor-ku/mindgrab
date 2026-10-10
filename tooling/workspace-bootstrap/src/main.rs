use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use toml_edit::{Array, DocumentMut, InlineTable, Item, Table, Value, value};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type Environment = BTreeMap<String, String>;

const ENVIRONMENT_KEYS: [&str; 8] = [
    "COMPOSE_PROJECT_NAME",
    "WEBAPP_PORT",
    "PORT",
    "POSTGRES_PORT",
    "DATABASE_URL",
    "VITE_BACKEND_URL",
    "WORKOS_REDIRECT_URI",
    "APP_URL",
];
const PORT_KEYS: [&str; 3] = ["WEBAPP_PORT", "PORT", "POSTGRES_PORT"];
const CONFIG: &str = "mise.local.toml";
const LOCK: &str = "mindgrab-worktree-bootstrap.lock";

fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "Cannot read Git worktree information: git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn read_config(root: &Path) -> Result<DocumentMut> {
    match fs::read_to_string(root.join(CONFIG)) {
        Ok(text) => Ok(text.parse()?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DocumentMut::new()),
        Err(error) => Err(error.into()),
    }
}

fn port(item: &Item) -> Option<u16> {
    let number = match item.as_str() {
        Some(text) => text.trim().parse::<u16>().ok(),
        None => item
            .as_integer()
            .and_then(|number| u16::try_from(number).ok()),
    };
    number.filter(|number| *number != 0)
}

struct BootstrapLock(PathBuf);

impl BootstrapLock {
    fn acquire(path: PathBuf) -> Result<Self> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "Bootstrap lock is busy: {}. If no bootstrap is running, remove this stale lock directory and retry.",
                            path.display()
                        )
                        .into());
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Drop for BootstrapLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn bootstrap(directory: &Path) -> Result<Environment> {
    let root = fs::canonicalize(directory)?;
    let common = git(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let _lock = BootstrapLock::acquire(Path::new(common.trim()).join(LOCK))?;
    let worktrees: Vec<PathBuf> = git(&root, &["worktree", "list", "--porcelain", "-z"])?
        .split('\0')
        .filter_map(|field| field.strip_prefix("worktree ").map(PathBuf::from))
        .collect();
    let mut reserved_ports = HashSet::new();
    let mut projects = HashSet::new();
    for worktree in &worktrees {
        if worktree == &root {
            continue;
        }
        let config = read_config(worktree)?;
        if let Some(env) = config.get("env").and_then(Item::as_table_like) {
            for key in PORT_KEYS {
                if let Some(number) = env.get(key).and_then(port) {
                    reserved_ports.insert(number);
                }
            }
            if let Some(project) = env.get("COMPOSE_PROJECT_NAME").and_then(Item::as_str) {
                projects.insert(project.to_owned());
            }
        }
    }

    let mut config = read_config(&root)?;
    let mut env = match config.remove("env") {
        None => Table::new(),
        Some(Item::Table(table)) => table,
        Some(Item::Value(Value::InlineTable(table))) => table.into_table(),
        Some(_) => return Err("mise.local.toml env must be a table".into()),
    };
    if ENVIRONMENT_KEYS.iter().any(|key| env.contains_key(key)) {
        let saved: Environment = ENVIRONMENT_KEYS
            .iter()
            .filter_map(|key| {
                env.get(key)
                    .and_then(Item::as_str)
                    .map(|text| ((*key).to_owned(), text.to_owned()))
            })
            .collect();
        if saved.len() != ENVIRONMENT_KEYS.len()
            || PORT_KEYS
                .iter()
                .any(|key| env.get(key).and_then(port).is_none())
        {
            return Err("mise.local.toml has incomplete worktree settings. Configure all bootstrap variables or remove those variables and rerun; existing settings were preserved.".into());
        }
        let ports: HashSet<u16> = PORT_KEYS.iter().filter_map(|key| port(&env[key])).collect();
        if ports.len() != 3
            || !ports.is_disjoint(&reserved_ports)
            || projects.contains(&saved["COMPOSE_PROJECT_NAME"])
        {
            return Err(
                "Existing worktree ports or Compose project conflict with another worktree.".into(),
            );
        }
        // Preserve saved ports and database volumes, even while servers are running.
        return Ok(saved);
    }

    let root_text = root.to_str().ok_or("Worktree path must be valid UTF-8")?;
    let hash = Sha256::digest(root_text.as_bytes());
    let start = u32::from_be_bytes(hash[..4].try_into()?) % 10_000;
    // IPv4-only hosts can bootstrap without requiring an IPv6 listener.
    let check_ipv6 = port_check::free_local_ipv6_port().is_some();
    let [webapp, backend, postgres] = (0..10_000)
        .map(|offset| {
            let first = (20_000 + ((start + offset) % 10_000) * 3) as u16;
            [first, first + 1, first + 2]
        })
        .find(|candidate| {
            candidate.iter().all(|&number| {
                !reserved_ports.contains(&number)
                    && port_check::is_local_ipv4_port_free(number)
                    && (!check_ipv6 || port_check::is_local_ipv6_port_free(number))
            })
        })
        .ok_or("No available worktree ports in the range 20000–49999.")?;
    let name: String = root
        .file_name()
        .ok_or("Worktree path must have a name")?
        .to_string_lossy()
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    let project = format!("mindgrab-{name}-{}", hex::encode(&hash[..6]));
    if projects.contains(&project) {
        return Err("Compose project is already reserved by another worktree.".into());
    }
    let environment: Environment = [
        ("COMPOSE_PROJECT_NAME", project),
        ("WEBAPP_PORT", webapp.to_string()),
        ("PORT", backend.to_string()),
        ("POSTGRES_PORT", postgres.to_string()),
        (
            "DATABASE_URL",
            format!("postgres://postgres@127.0.0.1:{postgres}/mindgrab"),
        ),
        ("VITE_BACKEND_URL", format!("http://127.0.0.1:{backend}")),
        (
            "WORKOS_REDIRECT_URI",
            format!("http://localhost:{webapp}/api/auth/callback"),
        ),
        ("APP_URL", format!("http://localhost:{webapp}/")),
    ]
    .into_iter()
    .map(|(key, text)| (key.to_owned(), text))
    .collect();

    let mut sources = match env.remove("_") {
        Some(item) => match item
            .into_value()
            .map_err(|_| "mise.local.toml env._ must be a table")?
        {
            Value::InlineTable(table) => table,
            _ => return Err("mise.local.toml env._ must be a table".into()),
        },
        None => InlineTable::new(),
    };
    if !sources.contains_key("file") {
        let main = worktrees.first().ok_or("Git reported no worktrees")?;
        let mut files = Array::new();
        for directory in [main, &root] {
            if directory == &root && main == &root && !files.is_empty() {
                continue;
            }
            let mut file = InlineTable::new();
            file.insert(
                "path",
                Value::from(
                    directory
                        .join(".env")
                        .to_str()
                        .ok_or("Credential path must be valid UTF-8")?,
                ),
            );
            file.insert("redact", Value::from(true));
            files.push(Value::InlineTable(file));
        }
        sources.insert("file", Value::Array(files));
    }
    // Load credentials before generated URLs; a worktree's .env wins over shared credentials.
    let mut ordered_env = env.clone();
    ordered_env.clear();
    ordered_env.insert("_", value(Value::InlineTable(sources)));
    for (key, item) in env {
        ordered_env.insert(&key, item);
    }
    for (key, text) in &environment {
        ordered_env.insert(key, value(text));
    }
    config.insert("env", Item::Table(ordered_env));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(root.join(CONFIG))?;
    write!(
        file,
        "# Worktree environment generated by tooling/workspace-bootstrap.\n{config}"
    )?;
    Ok(environment)
}

fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let directory = match args.next() {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir()?,
    };
    if args.next().is_some() {
        return Err("Usage: workspace-bootstrap [worktree-directory]".into());
    }
    let env = bootstrap(&directory)?;
    println!(
        "Worktree environment ready in mise.local.toml ({})",
        env["COMPOSE_PROJECT_NAME"]
    );
    println!(
        "Webapp: {} Backend: {} Postgres: {}",
        env["APP_URL"], env["VITE_BACKEND_URL"], env["POSTGRES_PORT"]
    );
    println!("Start with mise run db, mise run backend:dev, and mise run webapp:dev.");
    Ok(())
}

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests;
