use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

fn main() {
    println!("cargo:rerun-if-changed=../frontend");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR must be set"));

    for package in ["lit", "typescript"] {
        if let Err(problem) = check_installed_package(package) {
            println!("cargo::error={problem}; run `npm ci` in frontend/ before building");
            return;
        }
    }
    let frontend = out_dir.join("frontend");
    if let Err(problem) = compile_frontend(&frontend) {
        for line in problem.lines() {
            println!("cargo::error={line}");
        }
        return;
    }
    write_source_map_table(&out_dir, &frontend);

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

// The static asset table embeds Lit from frontend/node_modules, and the
// TypeScript there compiles the frontend modules; each must be the version
// frontend/package.json names.
fn check_installed_package(name: &str) -> Result<(), String> {
    let wanted = read_json("../frontend/package.json")
        .and_then(|package| package["dependencies"][name].as_str().map(str::to_owned))
        .ok_or_else(|| format!("frontend/package.json does not name a {name} version"))?;
    let installed = read_json(&format!("../frontend/node_modules/{name}/package.json"))
        .and_then(|package| package["version"].as_str().map(str::to_owned));
    match installed {
        Some(installed) if installed == wanted => Ok(()),
        Some(installed) => Err(format!(
            "frontend/node_modules holds {name} {installed}, but frontend/package.json needs {wanted}"
        )),
        None => Err(format!(
            "frontend/node_modules does not hold {name} {wanted}"
        )),
    }
}

// The static asset table embeds each frontend TypeScript module as the
// JavaScript and source map tsc writes to the same path under `output`. The
// page modules and the service worker are typed for different globals, so
// each has its own project; a type error in either stops the build.
fn compile_frontend(output: &Path) -> Result<(), String> {
    if output.exists() {
        fs::remove_dir_all(output)
            .map_err(|error| format!("{} could not be cleared: {error}", output.display()))?;
    }
    let compilers = ["tsconfig.json", "tsconfig.worker.json"].map(|project| {
        let child = Command::new("node")
            .arg("../frontend/node_modules/typescript/bin/tsc")
            .arg("--project")
            .arg(format!("../frontend/{project}"))
            .args(["--noEmit", "false", "--outDir"])
            .arg(output)
            .stdout(Stdio::piped())
            .spawn();
        (project, child)
    });
    let mut problems = Vec::new();
    for (project, child) in compilers {
        let compiled = child
            .and_then(|child| child.wait_with_output())
            .map_err(|error| {
                format!(
                    "Node.js must be on PATH to compile the frontend's TypeScript modules: {error}"
                )
            })?;
        if !compiled.status.success() {
            problems.push(format!(
                "tsc could not compile frontend/{project} ({})",
                compiled.status
            ));
            problems.extend(
                String::from_utf8_lossy(&compiled.stdout)
                    .lines()
                    .map(str::to_owned),
            );
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n"))
    }
}

// The static asset table answers `<module>.js.map` from this table of every
// source map tsc wrote.
fn write_source_map_table(out_dir: &Path, frontend: &Path) {
    let mut maps = Vec::new();
    collect_source_maps(frontend, frontend, &mut maps);
    maps.sort();
    let arms: String = maps
        .iter()
        .map(|map| {
            let file = format!("/frontend/{map}");
            format!(
                "        {map:?} => Some(include_bytes!(concat!(env!(\"OUT_DIR\"), {file:?}))),\n"
            )
        })
        .collect();
    let table = format!(
        "fn compiled_source_map(path: &str) -> Option<&'static [u8]> {{\n    match path {{\n{arms}        _ => None,\n    }}\n}}\n"
    );
    fs::write(out_dir.join("source_maps.rs"), table).expect("source map table must be written");
}

fn collect_source_maps(root: &Path, directory: &Path, maps: &mut Vec<String>) {
    for entry in fs::read_dir(directory).expect("compiled frontend must be readable") {
        let path = entry
            .expect("compiled frontend entry must be readable")
            .path();
        if path.is_dir() {
            collect_source_maps(root, &path, maps);
        } else if path.to_string_lossy().ends_with(".js.map") {
            let relative = path
                .strip_prefix(root)
                .expect("map must be under the compiled frontend");
            maps.push(relative.to_string_lossy().into_owned());
        }
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
