//! Only the native protobuf fields this reader consumes, pinned to the official
//! Antigravity ACP 1.4.5 distribution. Tags come from trajectory_pb2/cortex_pb2
//! and codeium_common_pb2; unknown optional fields remain with their owner.
//! This is a read-only schema, not a serializer for modifying native records.

use prost::{Message, Oneof};

#[derive(Clone, PartialEq, Message)]
pub(super) struct Step {
    #[prost(int32, tag = "1")]
    pub(super) kind: i32,
    #[prost(int32, tag = "4")]
    pub(super) status: i32,
    #[prost(message, optional, tag = "5")]
    pub(super) metadata: Option<StepMetadata>,
    #[prost(oneof = "Payload", tags = "10, 14, 19, 20, 24, 28, 47, 98, 104, 127")]
    pub(super) payload: Option<Payload>,
}

#[derive(Clone, PartialEq, Oneof)]
pub(super) enum Payload {
    #[prost(message, tag = "10")]
    CodeAction(CodeAction),
    #[prost(message, tag = "14")]
    ViewFile(ViewFile),
    #[prost(message, tag = "19")]
    UserInput(UserInput),
    #[prost(message, tag = "20")]
    PlannerResponse(PlannerResponse),
    #[prost(message, tag = "24")]
    ErrorMessage(ErrorMessage),
    #[prost(message, tag = "28")]
    RunCommand(RunCommand),
    #[prost(message, tag = "47")]
    McpTool(McpTool),
    #[prost(message, tag = "98")]
    FileChange(FileChange),
    #[prost(message, tag = "104")]
    GenerateImage(GenerateImage),
    #[prost(message, tag = "127")]
    ShellExec(ShellExec),
}

impl Payload {
    pub(super) fn native_type(&self) -> i32 {
        match self {
            Self::CodeAction(_) => 5,
            Self::ViewFile(_) => 8,
            Self::UserInput(_) => 14,
            Self::PlannerResponse(_) => 15,
            Self::ErrorMessage(_) => 17,
            Self::RunCommand(_) => 21,
            Self::McpTool(_) => 38,
            Self::FileChange(_) => 86,
            Self::GenerateImage(_) => 91,
            Self::ShellExec(_) => 112,
        }
    }
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct StepMetadata {
    #[prost(message, optional, tag = "1")]
    pub(super) created_at: Option<Timestamp>,
    #[prost(message, optional, tag = "6")]
    pub(super) viewable_at: Option<Timestamp>,
    #[prost(message, optional, tag = "8")]
    pub(super) completed_at: Option<Timestamp>,
    #[prost(message, optional, tag = "22")]
    pub(super) last_chunk_at: Option<Timestamp>,
    #[prost(message, optional, tag = "32")]
    pub(super) started_at: Option<Timestamp>,
    #[prost(message, optional, tag = "4")]
    pub(super) tool_call: Option<ToolCall>,
    #[prost(message, optional, tag = "9")]
    pub(super) model_usage: Option<ModelUsage>,
    #[prost(string, tag = "12")]
    pub(super) execution_id: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct Timestamp {
    #[prost(int64, tag = "1")]
    pub(super) seconds: i64,
    #[prost(int32, tag = "2")]
    pub(super) nanos: i32,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct TrajectoryMetadata {
    #[prost(message, optional, tag = "2")]
    pub(super) created_at: Option<Timestamp>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ExecutorMetadata {
    #[prost(int32, tag = "1")]
    pub(super) termination_reason: i32,
    #[prost(int32, tag = "3")]
    pub(super) last_step_idx: i32,
    #[prost(string, tag = "9")]
    pub(super) execution_id: String,
    #[prost(string, optional, tag = "12")]
    pub(super) execution_error: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ModelUsage {
    #[prost(uint64, tag = "2")]
    pub(super) input_tokens: u64,
    #[prost(uint64, tag = "3")]
    pub(super) output_tokens: u64,
    #[prost(uint64, tag = "4")]
    pub(super) cache_write_tokens: u64,
    #[prost(uint64, tag = "5")]
    pub(super) cache_read_tokens: u64,
    #[prost(uint64, tag = "9")]
    pub(super) thinking_tokens: u64,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ToolCall {
    #[prost(string, tag = "1")]
    pub(super) id: String,
    #[prost(string, tag = "2")]
    pub(super) name: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct UserInput {
    #[prost(string, tag = "2")]
    pub(super) response: String,
    #[prost(message, repeated, tag = "5")]
    pub(super) images: Vec<ImageData>,
    #[prost(message, repeated, tag = "9")]
    pub(super) media: Vec<Media>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct PlannerResponse {
    #[prost(string, tag = "1")]
    pub(super) response: String,
    #[prost(string, tag = "8")]
    pub(super) modified_response: String,
    #[prost(string, tag = "3")]
    pub(super) thinking: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct RunCommand {
    #[prost(string, tag = "23")]
    pub(super) command_line: String,
    #[prost(string, tag = "2")]
    pub(super) cwd: String,
    #[prost(int32, optional, tag = "6")]
    pub(super) exit_code: Option<i32>,
    #[prost(bool, tag = "14")]
    pub(super) user_rejected: bool,
    #[prost(message, optional, tag = "21")]
    pub(super) combined_output: Option<CommandOutput>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct CommandOutput {
    #[prost(string, tag = "1")]
    pub(super) full: String,
    #[prost(string, tag = "2")]
    pub(super) truncated: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ShellExec {
    #[prost(string, tag = "1")]
    pub(super) command: String,
    #[prost(int32, optional, tag = "2")]
    pub(super) exit_code: Option<i32>,
    #[prost(string, tag = "3")]
    pub(super) output: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct CodeAction {
    #[prost(message, optional, tag = "2")]
    pub(super) result: Option<ActionResult>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ActionResult {
    #[prost(message, optional, tag = "1")]
    pub(super) edit: Option<ActionEdit>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ActionEdit {
    #[prost(string, tag = "1")]
    pub(super) absolute_path: String,
    #[prost(string, tag = "8")]
    pub(super) absolute_uri: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct FileChange {
    #[prost(string, tag = "1")]
    pub(super) absolute_path_uri: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ViewFile {
    #[prost(string, tag = "1")]
    pub(super) absolute_path_uri: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct McpTool {
    #[prost(string, tag = "1")]
    pub(super) server: String,
    #[prost(message, optional, tag = "2")]
    pub(super) call: Option<ToolCall>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ErrorMessage {
    #[prost(message, optional, tag = "3")]
    pub(super) error: Option<ErrorDetails>,
    #[prost(bool, tag = "5")]
    pub(super) show_user: bool,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ErrorDetails {
    #[prost(string, tag = "1")]
    pub(super) user_message: String,
    #[prost(string, tag = "2")]
    pub(super) short_error: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct GenerateImage {
    #[prost(string, tag = "1")]
    pub(super) prompt: String,
    #[prost(string, repeated, tag = "2")]
    pub(super) paths: Vec<String>,
    #[prost(message, optional, tag = "3")]
    pub(super) image: Option<ImageData>,
    #[prost(message, optional, tag = "6")]
    pub(super) media: Option<Media>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ImageData {
    #[prost(string, tag = "1")]
    pub(super) base64_data: String,
    #[prost(string, tag = "2")]
    pub(super) mime_type: String,
    #[prost(string, tag = "4")]
    pub(super) uri: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct Media {
    #[prost(string, tag = "1")]
    pub(super) mime_type: String,
    #[prost(bytes = "vec", tag = "2")]
    pub(super) inline_data: Vec<u8>,
    #[prost(string, tag = "5")]
    pub(super) uri: String,
}
