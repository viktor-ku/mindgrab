use mindgrab_state::{
    COLOR_FAMILIES, COLOR_SHADES, ColorPreferences, Command, CommandResult, DEFAULT_QUICK_COLORS,
    NAMED_COLORS, Node, Position, ProjectView, SavingPreferences,
};
use ts_rs::{Config, TS};

fn union<T: std::fmt::Display>(values: &[T], quote: bool) -> String {
    values
        .iter()
        .map(|value| {
            if quote {
                format!("\"{value}\"")
            } else {
                value.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

fn main() {
    let config = Config::default();
    println!("// Generated from Rust by mise run state:build. Do not edit.");
    // Color is stored as text; these spell out every text it accepts.
    println!(
        "export type ColorFamily = {};",
        union(&COLOR_FAMILIES, true)
    );
    println!("export type ColorShade = {};", union(&COLOR_SHADES, false));
    println!("export type NamedColor = {};", union(&NAMED_COLORS, true));
    println!("export type Color = NamedColor | `${{ColorFamily}}-${{ColorShade}}`;");
    // The quick picks a map offers until someone changes them.
    println!(
        "export const DEFAULT_QUICK_COLORS: readonly Color[] = [{}];",
        DEFAULT_QUICK_COLORS
            .iter()
            .map(|color| format!("\"{color}\""))
            .collect::<Vec<_>>()
            .join(", ")
    );
    for declaration in [
        Position::decl(&config),
        SavingPreferences::decl(&config),
        ColorPreferences::decl(&config),
        Node::decl(&config),
        ProjectView::decl(&config),
        Command::decl(&config),
        CommandResult::decl(&config),
    ] {
        println!("export {declaration}");
    }
}
