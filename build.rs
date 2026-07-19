use std::{
    env, fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn main() {
    println!("cargo:rerun-if-changed=frontend");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");

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
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR must be set"));
    fs::write(out_dir.join("build-info.js"), module).expect("build info module must be written");

    println!("cargo:rustc-env=CAFFOLD_BUILD_ID={build_id}");
    println!("cargo:rustc-env=CAFFOLD_BUILD_LABEL={build_id}");
    println!("cargo:rustc-env=CAFFOLD_BUILD_NUMBER={build_number}");
}

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}
