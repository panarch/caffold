//! The languages the code viewers can navigate, and what each one's language
//! server needs from Caffold.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Language {
    Rust,
    TypeScript,
}

/// How a started server shows that its index is complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReadySignal {
    /// rust-analyzer's `experimental/serverStatus` reports `quiescent`.
    Quiescent,
    /// The server answers as soon as `initialize` returns.
    Initialized,
}

/// Each source file extension a server reads: its language and the LSP
/// language id its documents open with.
const SOURCE_FILES: [(&str, Language, &str); 9] = [
    ("rs", Language::Rust, "rust"),
    ("ts", Language::TypeScript, "typescript"),
    ("mts", Language::TypeScript, "typescript"),
    ("cts", Language::TypeScript, "typescript"),
    ("tsx", Language::TypeScript, "typescriptreact"),
    ("js", Language::TypeScript, "javascript"),
    ("mjs", Language::TypeScript, "javascript"),
    ("cjs", Language::TypeScript, "javascript"),
    ("jsx", Language::TypeScript, "javascriptreact"),
];

impl Language {
    pub(crate) const ALL: [Language; 2] = [Language::Rust, Language::TypeScript];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Language::Rust => "Rust",
            Language::TypeScript => "TypeScript/JavaScript",
        }
    }

    pub(crate) fn server_name(self) -> &'static str {
        match self {
            Language::Rust => "rust-analyzer",
            Language::TypeScript => "typescript-language-server",
        }
    }

    /// The command that installs this language's server on the host: for
    /// Rust into `toolchain`, the rustup toolchain the project uses, when
    /// rustup chooses its Rust.
    pub(crate) fn install_command(self, toolchain: Option<&str>) -> String {
        match (self, toolchain) {
            (Language::Rust, Some(toolchain)) => {
                format!("rustup component add rust-analyzer rust-src --toolchain {toolchain}")
            }
            (Language::Rust, None) => "rustup component add rust-analyzer rust-src".to_string(),
            (Language::TypeScript, _) => {
                "npm install --global typescript-language-server typescript".to_string()
            }
        }
    }

    /// The command that shows the installed server runs, in the same
    /// toolchain the install went into.
    pub(crate) fn check_command(self, toolchain: Option<&str>) -> String {
        match (self, toolchain) {
            (Language::Rust, Some(toolchain)) => {
                format!("rustup run {toolchain} rust-analyzer --version")
            }
            _ => format!("{} --version", self.server_name()),
        }
    }

    /// The language of a source file and the LSP language id its documents
    /// open with, or `None` for a file no supported server reads.
    pub(crate) fn for_file(path: &Path) -> Option<(Language, &'static str)> {
        let extension = path.extension()?.to_str()?;
        SOURCE_FILES
            .iter()
            .find(|(candidate, _, _)| *candidate == extension)
            .map(|(_, language, id)| (*language, *id))
    }

    /// The extensions of the files this language's server reads.
    pub(crate) fn extensions(self) -> Vec<&'static str> {
        SOURCE_FILES
            .iter()
            .filter(|(_, language, _)| *language == self)
            .map(|(extension, _, _)| *extension)
            .collect()
    }

    /// Files whose presence marks a project of this language.
    pub(super) fn project_markers(self) -> &'static [&'static str] {
        match self {
            Language::Rust => &["Cargo.toml"],
            Language::TypeScript => &["tsconfig.json", "jsconfig.json", "package.json"],
        }
    }

    pub(super) fn server_arguments(self) -> &'static [&'static str] {
        match self {
            Language::Rust => &[],
            Language::TypeScript => &["--stdio"],
        }
    }

    /// Sent as `initializationOptions` and as the answer to every
    /// `workspace/configuration` item.
    pub(super) fn configuration(self) -> Value {
        match self {
            // A target directory of its own keeps rust-analyzer's build of
            // build scripts and proc macros out of the agent's cargo lock.
            Language::Rust => json!({
                "cargo": { "targetDir": true },
                "checkOnSave": false,
                "files": { "watcher": "server" },
            }),
            Language::TypeScript => json!({}),
        }
    }

    pub(super) fn ready_signal(self) -> ReadySignal {
        match self {
            Language::Rust => ReadySignal::Quiescent,
            Language::TypeScript => ReadySignal::Initialized,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_names_its_language_and_document_language_id() {
        let language = |name: &str| Language::for_file(Path::new(name));

        assert_eq!(language("src/main.rs"), Some((Language::Rust, "rust")));
        assert_eq!(language("a.ts"), Some((Language::TypeScript, "typescript")));
        assert_eq!(
            language("a.mts"),
            Some((Language::TypeScript, "typescript"))
        );
        assert_eq!(
            language("Page.tsx"),
            Some((Language::TypeScript, "typescriptreact"))
        );
        assert_eq!(
            language("a.cjs"),
            Some((Language::TypeScript, "javascript"))
        );
        assert_eq!(
            language("a.jsx"),
            Some((Language::TypeScript, "javascriptreact"))
        );
        assert_eq!(language("README.md"), None);
        assert_eq!(language("Makefile"), None);
    }

    #[test]
    fn each_language_names_the_extensions_its_server_reads() {
        assert_eq!(Language::Rust.extensions(), ["rs"]);
        assert_eq!(
            Language::TypeScript.extensions(),
            ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"]
        );
    }

    #[test]
    fn a_rust_install_names_the_project_toolchain_and_typescript_installs_globally() {
        let toolchain = Some("1.94-aarch64-apple-darwin");

        assert_eq!(
            Language::Rust.install_command(toolchain),
            "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin"
        );
        assert_eq!(
            Language::Rust.check_command(toolchain),
            "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version"
        );
        assert_eq!(
            Language::Rust.install_command(None),
            "rustup component add rust-analyzer rust-src"
        );
        assert_eq!(
            Language::Rust.check_command(None),
            "rust-analyzer --version"
        );
        assert_eq!(
            Language::TypeScript.install_command(None),
            "npm install --global typescript-language-server typescript"
        );
        assert_eq!(
            Language::TypeScript.check_command(None),
            "typescript-language-server --version"
        );
    }

    #[test]
    fn languages_serialize_by_their_lowercase_names() {
        assert_eq!(
            serde_json::to_value(Language::ALL).unwrap(),
            json!(["rust", "typescript"])
        );
    }
}
