use mindgrab_state::{
    Color, Command, CommandResult, Node, Position, ProjectView, SavingPreferences,
};
use ts_rs::{Config, TS};

fn main() {
    let config = Config::default();
    println!("// Generated from Rust by mise run state:build. Do not edit.");
    for declaration in [
        Color::decl(&config),
        Position::decl(&config),
        SavingPreferences::decl(&config),
        Node::decl(&config),
        ProjectView::decl(&config),
        Command::decl(&config),
        CommandResult::decl(&config),
    ] {
        println!("export {declaration}");
    }
}
