use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn main() {
    println!("cargo:rerun-if-changed=../frontend");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR must be set"));

    if let Err(problem) = check_installed_lit() {
        println!("cargo::error={problem}; run `npm ci` in frontend/ before building");
        return;
    }
    if let Err(problem) = strip_frontend_types(&out_dir.join("frontend")) {
        println!("cargo::error={problem}");
        return;
    }

    let commit =
        git_output(&["rev-parse", "--short=8", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    let dirty = git_output(&["status", "--porcelain", "--untracked-files=no"])
        .is_some_and(|output| !output.is_empty());
    let build_number = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after the Unix epoch")
        .as_secs();
    let commit_label = if dirty {
        format!("{commit}-dirty")
    } else {
        commit
    };
    let build_id = format!("{commit_label}.{build_number}");
    let version = env::var("CARGO_PKG_VERSION").expect("Cargo package version must be set");
    let module = format!(
        "export const BUILD_INFO = Object.freeze({{\n  id: {build_id:?},\n  label: {build_id:?},\n  version: {version:?},\n  commit: {commit_label:?},\n  number: {build_number},\n}});\n"
    );
    fs::write(out_dir.join("build-info.js"), module).expect("build info module must be written");

    println!("cargo:rustc-env=CAFFOLD_BUILD_ID={build_id}");
    println!("cargo:rustc-env=CAFFOLD_BUILD_LABEL={build_id}");
    println!("cargo:rustc-env=CAFFOLD_BUILD_NUMBER={build_number}");
}

// The static asset table embeds Lit from frontend/node_modules, which must
// hold the version frontend/package.json names.
fn check_installed_lit() -> Result<(), String> {
    let wanted = read_json("../frontend/package.json")
        .and_then(|package| package["dependencies"]["lit"].as_str().map(str::to_owned))
        .ok_or("frontend/package.json does not name a Lit version")?;
    let installed = read_json("../frontend/node_modules/lit/package.json")
        .and_then(|package| package["version"].as_str().map(str::to_owned));
    match installed {
        Some(installed) if installed == wanted => Ok(()),
        Some(installed) => Err(format!(
            "frontend/node_modules holds lit {installed}, but frontend/package.json needs {wanted}"
        )),
        None => Err(format!("frontend/node_modules does not hold lit {wanted}")),
    }
}

// The static asset table embeds each frontend TypeScript module as the
// JavaScript this writes to the same path under `output`.
fn strip_frontend_types(output: &Path) -> Result<(), String> {
    let status = Command::new("node")
        .args([
            "--disable-warning=ExperimentalWarning",
            "../frontend/strip-types.mjs",
            "../frontend",
        ])
        .arg(output)
        .status()
        .map_err(|error| {
            format!(
                "Node.js 24 or newer must be on PATH to build the frontend's TypeScript modules: {error}"
            )
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "frontend/strip-types.mjs could not write the frontend's TypeScript modules ({status})"
        ))
    }
}

fn read_json(path: &str) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}
