use super::*;
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
use tempfile::{TempDir, tempdir};

fn repository() -> Result<TempDir> {
    let root = tempdir()?;
    git(root.path(), &["init", "--quiet"])?;
    git(
        root.path(),
        &[
            "-c",
            "user.name=Bootstrap Test",
            "-c",
            "user.email=bootstrap@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "init",
        ],
    )?;
    Ok(root)
}

fn worktree(root: &Path, name: &str) -> Result<PathBuf> {
    let path = root.join(name);
    git(
        root,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            path.to_str().unwrap(),
        ],
    )?;
    Ok(path)
}

#[test]
fn concurrent_bootstraps_isolate_ports_and_compose_projects() -> Result<()> {
    let root = repository()?;
    let first = worktree(root.path(), "worker one")?;
    let second = worktree(root.path(), "worker two")?;
    let environments = thread::scope(|scope| {
        let first = scope.spawn(|| bootstrap(&first));
        let second = scope.spawn(|| bootstrap(&second));
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>([
            first.join().unwrap()?,
            second.join().unwrap()?,
        ])
    })?;
    let ports: HashSet<_> = environments
        .iter()
        .flat_map(|env| PORT_KEYS.map(|key| env[key].clone()))
        .collect();
    assert_eq!(ports.len(), 6);
    assert_ne!(
        environments[0]["COMPOSE_PROJECT_NAME"],
        environments[1]["COMPOSE_PROJECT_NAME"]
    );
    for env in environments {
        assert!(
            env["COMPOSE_PROJECT_NAME"]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        );
        assert_eq!(
            env["DATABASE_URL"],
            format!(
                "postgres://postgres@127.0.0.1:{}/mindgrab",
                env["POSTGRES_PORT"]
            )
        );
        assert_eq!(
            env["VITE_BACKEND_URL"],
            format!("http://127.0.0.1:{}", env["PORT"])
        );
        assert_eq!(
            env["WORKOS_REDIRECT_URI"],
            format!("{}api/auth/callback", env["APP_URL"])
        );
    }
    assert!(!root.path().join(".git").join(LOCK).exists());
    Ok(())
}

#[test]
fn reruns_preserve_configuration_with_active_servers() -> Result<()> {
    let root = repository()?;
    fs::write(
        root.path().join(CONFIG),
        "# Keep this comment\n[env]\nCUSTOM = \"keep me\"\n[tasks.custom]\nrun = \"echo custom\"\n",
    )?;
    let env = bootstrap(root.path())?;
    let before = fs::read_to_string(root.path().join(CONFIG))?;
    let config = read_config(root.path())?;
    assert_eq!(config["env"]["CUSTOM"].as_str(), Some("keep me"));
    assert_eq!(
        config["tasks"]["custom"]["run"].as_str(),
        Some("echo custom")
    );
    assert!(before.contains("# Keep this comment"));
    let _listener = TcpListener::bind((Ipv4Addr::LOCALHOST, env["WEBAPP_PORT"].parse::<u16>()?))?;
    assert_eq!(bootstrap(root.path())?, env);
    assert_eq!(fs::read_to_string(root.path().join(CONFIG))?, before);
    Ok(())
}

#[test]
fn skips_reserved_and_occupied_ports() -> Result<()> {
    let root = repository()?;
    let target = worktree(root.path(), "target")?;
    let other = worktree(root.path(), "other")?;
    let original = bootstrap(&target)?;
    fs::write(
        other.join(CONFIG),
        format!("[env]\nWEBAPP_PORT = \"{}\"\n", original["WEBAPP_PORT"]),
    )?;
    fs::remove_file(target.join(CONFIG))?;
    assert_ne!(bootstrap(&target)?["WEBAPP_PORT"], original["WEBAPP_PORT"]);
    fs::remove_file(other.join(CONFIG))?;
    fs::remove_file(target.join(CONFIG))?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, original["PORT"].parse::<u16>()?))?;
    assert_ne!(bootstrap(&target)?["PORT"], original["PORT"]);
    drop(listener);
    if port_check::free_local_ipv6_port().is_some() {
        fs::remove_file(target.join(CONFIG))?;
        let _listener = TcpListener::bind((Ipv6Addr::LOCALHOST, original["PORT"].parse::<u16>()?))?;
        assert_ne!(bootstrap(&target)?["PORT"], original["PORT"]);
    }
    Ok(())
}

#[test]
fn references_credentials_without_copying_secrets() -> Result<()> {
    let root = repository()?;
    let target = worktree(root.path(), "target")?;
    fs::write(root.path().join(".env"), "WORKOS_API_KEY=shared-secret\n")?;
    fs::write(target.join(".env"), "WORKOS_API_KEY=local-secret\n")?;
    bootstrap(&target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(target.join(CONFIG))?.permissions().mode() & 0o777,
            0o600
        );
    }
    let text = fs::read_to_string(target.join(CONFIG))?;
    assert!(!text.contains("shared-secret"));
    assert!(!text.contains("local-secret"));
    let config = read_config(&target)?;
    let files = config["env"]["_"]["file"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    for (file, directory) in files.iter().zip([root.path(), target.as_path()]) {
        let file = file.as_inline_table().unwrap();
        assert_eq!(file["path"].as_str(), directory.join(".env").to_str());
        assert_eq!(file["redact"].as_bool(), Some(true));
    }
    let main = bootstrap(root.path())?;
    assert!(!main.is_empty());
    assert_eq!(
        read_config(root.path())?["env"]["_"]["file"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    Ok(())
}

#[test]
fn mise_loads_credentials_before_generated_urls() -> Result<()> {
    let root = repository()?;
    let target = worktree(root.path(), "target")?;
    fs::write(
        root.path().join(".env"),
        "WORKOS_CLIENT_ID=shared-client\nWORKOS_API_KEY=shared-secret\nPORT=3000\nWORKOS_REDIRECT_URI=http://localhost:5173/api/auth/callback\n",
    )?;
    let generated = bootstrap(&target)?;
    fs::write(
        target.join(".env"),
        "WORKOS_API_KEY=local-secret\nAPP_URL=http://localhost:5173/\n",
    )?;
    let result = match Command::new("mise")
        .args(["env", "--json"])
        .current_dir(&target)
        .env("MISE_YES", "1")
        .output()
    {
        Ok(result) => result,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let inherited: serde_json::Value = serde_json::from_slice(&result.stdout)?;
    assert_eq!(inherited["WORKOS_CLIENT_ID"], "shared-client");
    assert_eq!(inherited["WORKOS_API_KEY"], "local-secret");
    for (key, value) in generated {
        assert_eq!(inherited[&key], value, "{key}");
    }
    Ok(())
}

#[test]
fn preserves_explicit_credential_directives() -> Result<()> {
    let root = repository()?;
    fs::write(
        root.path().join(CONFIG),
        "[env]\nCUSTOM = \"keep\"\n[env._]\nfile = \"custom.env\"\npath = [\"bin\"]\n",
    )?;
    bootstrap(root.path())?;
    let config = read_config(root.path())?;
    assert_eq!(config["env"]["_"]["file"].as_str(), Some("custom.env"));
    assert_eq!(
        config["env"]["_"]["path"]
            .as_array()
            .unwrap()
            .get(0)
            .unwrap()
            .as_str(),
        Some("bin")
    );
    assert_eq!(config["env"]["CUSTOM"].as_str(), Some("keep"));
    Ok(())
}

#[test]
fn rejects_incomplete_settings_without_overwriting() -> Result<()> {
    let root = repository()?;
    let text = "[env]\nPORT = \"13000\"\nCUSTOM = \"keep me\"\n";
    fs::write(root.path().join(CONFIG), text)?;
    assert!(
        bootstrap(root.path())
            .unwrap_err()
            .to_string()
            .contains("incomplete worktree settings")
    );
    assert_eq!(fs::read_to_string(root.path().join(CONFIG))?, text);
    assert!(!root.path().join(".git").join(LOCK).exists());
    Ok(())
}

#[test]
fn rejects_copied_worktree_settings() -> Result<()> {
    let root = repository()?;
    let first = worktree(root.path(), "first")?;
    let second = worktree(root.path(), "second")?;
    bootstrap(&first)?;
    fs::copy(first.join(CONFIG), second.join(CONFIG))?;
    assert!(
        bootstrap(&second)
            .unwrap_err()
            .to_string()
            .contains("conflict with another worktree")
    );
    Ok(())
}
