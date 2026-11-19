//! Keep the CLI's pending request and grants authoritative, including after reconnect.

use super::{
    CopilotClient,
    protocol::{Failure, Operation},
};
use crate::agent::{
    AgentError, ApprovalArgument, ApprovalDecision, ApprovalDetail, ApprovalRequest,
    ApprovalToolDetail, approval::ApprovalSource,
};
use async_trait::async_trait;
use copilot_sdk::{
    PermissionRequestData, RequestId, SessionId,
    handler::{PermissionHandler, PermissionResult},
    session::Session,
};
use serde_json::{Value, json};

pub(crate) enum ApprovalReply {
    Delivered,
    NoLongerPending,
}

impl CopilotClient {
    /// Send once. A missing receipt can only retire this card if the SDK confirms its absence.
    pub(crate) async fn resolve_approval(
        &self,
        task: &str,
        approval_id: &str,
        decision: ApprovalDecision,
        source: ApprovalSource,
    ) -> Result<ApprovalReply, AgentError> {
        let id = approval_id
            .strip_prefix(&format!("copilot:{task}:"))
            .ok_or_else(|| {
                AgentError::Failed("This approval belongs to another Copilot Task.".into())
            })?;

        let connection = self.current(task).await?;
        let failure = match connection
            .request(Operation::Decide {
                request: id.into(),
                decision,
                source,
            })
            .await
        {
            Ok(receipt) => match receipt.as_bool() {
                Some(true) => return Ok(ApprovalReply::Delivered),
                Some(false) => return Ok(ApprovalReply::NoLongerPending),
                None => AgentError::Failed("Invalid Copilot approval receipt.".into()),
            },
            Err(error) => error,
        };

        let snapshot = self
            .current(task)
            .await?
            .request(Operation::Inspect)
            .await?;
        if pending_permissions(&snapshot)?
            .iter()
            .any(|(pending_id, _)| *pending_id == id)
        {
            Err(failure)
        } else {
            Ok(ApprovalReply::NoLongerPending)
        }
    }
}

pub(super) fn pending_permissions(snapshot: &Value) -> Result<Vec<(&str, &Value)>, AgentError> {
    let invalid = || AgentError::Failed("Invalid Copilot pending permission snapshot.".into());
    snapshot["permissions"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|entry| {
            let id = entry["requestId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(invalid)?;
            let request = entry
                .get("request")
                .filter(|value| value.is_object())
                .ok_or_else(invalid)?;
            Ok((id, request))
        })
        .collect()
}

pub(super) struct PendingPermissions;

#[async_trait]
impl PermissionHandler for PendingPermissions {
    async fn handle(
        &self,
        _: SessionId,
        _: RequestId,
        _: PermissionRequestData,
    ) -> PermissionResult {
        // Caffold can disconnect while the approval card is open. The runtime
        // keeps this request answerable by its original ID.
        PermissionResult::no_result()
    }
}

pub(super) fn card(
    task: &str,
    id: &str,
    request: &Value,
    turn_id: Option<String>,
    cwd: &str,
) -> Result<ApprovalRequest, Failure> {
    let kind = request["kind"]
        .as_str()
        .ok_or_else(|| Failure::Failed("Copilot permission request has no kind.".into()))?;
    let human = requires_human(request)?;

    let tool = request["toolName"].as_str();
    let server = request["serverName"].as_str();
    let command = request["fullCommandText"]
        .as_str()
        .or_else(|| request["command"].as_str());
    let tool_detail = server.zip(tool).map(|(server, tool)| ApprovalToolDetail {
        server_name: server.into(),
        app_name: Some(tool.into()),
        description: request["toolDescription"].as_str().map(str::to_owned),
        arguments: request["args"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, value)| ApprovalArgument {
                name: name.clone(),
                label: name.clone(),
                value: value.clone(),
            })
            .collect(),
    });

    let grant = scoped_grant(request);
    let domain = domain_grant(request);
    let mut decisions = vec![ApprovalDecision::Allow];
    if grant.is_some() {
        decisions.extend([
            ApprovalDecision::AllowForSession,
            ApprovalDecision::AllowAlways,
        ]);
    }
    if domain.is_some() {
        decisions.push(ApprovalDecision::AllowAlways);
    }
    decisions.extend([ApprovalDecision::Deny, ApprovalDecision::DenyAndStop]);

    Ok(ApprovalRequest {
        id: format!("copilot:{task}:{id}"),
        turn_id,
        requires_human: human,
        item_id: request["toolCallId"].as_str().map(str::to_owned),
        title: match (kind, tool) {
            ("mcp", Some(tool)) => format!("Run {tool}"),
            ("shell" | "commands", _) => "Run a command".into(),
            (kind, _) => format!("Allow Copilot {kind} access"),
        },
        reason: request["intention"]
            .as_str()
            .or_else(|| request["description"].as_str())
            .map(str::to_owned),
        detail: ApprovalDetail {
            command: command.map(str::to_owned),
            cwd: Some(cwd.to_owned()),
            tool: tool_detail,
            network_endpoint: request["url"].as_str().map(str::to_owned),
            permissions: grant
                .as_ref()
                .map(|(_, scope)| crate::agent::PermissionRow {
                    label: "Approval scope".into(),
                    value: scope.clone(),
                    verbatim: true,
                })
                .or_else(|| {
                    domain.map(|domain| crate::agent::PermissionRow {
                        label: "Always allow domain".into(),
                        value: domain,
                        verbatim: true,
                    })
                })
                .into_iter()
                .collect(),
            ..ApprovalDetail::default()
        },
        decisions,
    })
}

fn requires_human(request: &Value) -> Result<bool, Failure> {
    request
        .get("managedApprovalRequired")
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                Failure::Failed("Invalid Copilot human-approval requirement.".into())
            })
        })
        .transpose()
        .map(|human| human.unwrap_or(false))
}

fn scoped_grant(request: &Value) -> Option<(Value, String)> {
    if requires_human(request).ok()?
        || request["requestSandboxBypass"] == true
        || request["requestSandboxPermissive"] == true
    {
        return None;
    }

    match request["kind"].as_str()? {
        "mcp" => {
            let server = request["serverName"].as_str()?;
            let tool = request["toolName"].as_str()?;
            Some((
                json!({ "kind": "mcp", "serverName": server, "toolName": tool }),
                format!("{server} / {tool}"),
            ))
        }
        "commands" if request["canOfferSessionApproval"] == true => {
            let commands = request["commandIdentifiers"]
                .as_array()?
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            if commands.is_empty() {
                return None;
            }
            Some((
                json!({ "kind": "commands", "commandIdentifiers": commands }),
                commands.join(", "),
            ))
        }
        "read" => Some((json!({ "kind": "read" }), "All filesystem reads".into())),
        "write" if request["canOfferSessionApproval"] == true => {
            Some((json!({ "kind": "write" }), "All filesystem writes".into()))
        }
        _ => None,
    }
}

fn domain_grant(request: &Value) -> Option<String> {
    if requires_human(request).ok()?
        || request["kind"] != "url"
        || request["requestSandboxBypass"] == true
    {
        return None;
    }

    let url = url::Url::parse(request["url"].as_str()?).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.domain().map(str::to_owned)
}

fn decision_context(source: ApprovalSource) -> Value {
    match source {
        ApprovalSource::Human => json!({
            "source": "human_response",
            "surface": "sdk",
            "outcome": "prompted_user",
            "responseCapability": "interactive",
        }),
        ApprovalSource::HostPolicy => json!({
            "source": "host_policy",
            "surface": "sdk",
            "outcome": "auto_approved",
        }),
    }
}

pub(super) async fn decide(
    session: &Session,
    id: &str,
    decision: ApprovalDecision,
    source: ApprovalSource,
) -> Result<bool, Failure> {
    let permissions = session.rpc().permissions();
    let requests = permissions.pending_requests().await?;
    let Some(pending) = requests
        .items
        .into_iter()
        .find(|pending| &*pending.request_id == id)
    else {
        return Ok(false);
    };

    let request = serde_json::to_value(pending.request)?;
    if source == ApprovalSource::HostPolicy
        && (requires_human(&request)? || decision != ApprovalDecision::Allow)
    {
        return Err(Failure::Held(
            "This Copilot request requires a person's decision.".into(),
        ));
    }

    let result = match decision {
        ApprovalDecision::Allow => json!({ "kind": "approve-once" }),
        ApprovalDecision::Deny => json!({
            "kind": "reject",
            "feedback": "The user declined this tool request.",
        }),
        ApprovalDecision::DenyAndStop => json!({ "kind": "reject" }),
        ApprovalDecision::AllowAlways if domain_grant(&request).is_some() => {
            json!({ "kind": "approve-permanently", "domain": domain_grant(&request) })
        }
        ApprovalDecision::AllowForSession | ApprovalDecision::AllowAlways => {
            let (grant, _) = scoped_grant(&request).ok_or_else(|| {
                Failure::Held("Copilot did not offer this permission scope.".into())
            })?;
            if decision == ApprovalDecision::AllowForSession {
                json!({ "kind": "approve-for-session", "approval": grant })
            } else {
                let cwd = session.rpc().metadata().snapshot().await?.working_directory;
                let location = permissions
                    .locations()
                    .resolve(serde_json::from_value(json!({ "workingDirectory": cwd }))?)
                    .await?;
                json!({
                    "kind": "approve-for-location",
                    "locationKey": location.location_key,
                    "approval": grant,
                })
            }
        }
        ApprovalDecision::Cancel => {
            return Err(Failure::Held("Copilot did not offer this answer.".into()));
        }
    };

    let answer = permissions
        .handle_pending_permission_request(serde_json::from_value(json!({
            "requestId": id,
            "result": result,
            "decisionContext": decision_context(source),
        }))?)
        .await?;
    if !answer.success {
        return Err(Failure::Failed(
            "Copilot did not apply the approval decision.".into(),
        ));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_pending_snapshot_cannot_withdraw_an_approval() {
        let pending = json!({ "requestId": "one", "request": { "kind": "shell" } });
        let snapshot = json!({ "permissions": [pending] });
        assert_eq!(
            pending_permissions(&snapshot).unwrap(),
            vec![("one", &pending["request"])]
        );
        assert!(
            pending_permissions(&json!({ "permissions": [] }))
                .unwrap()
                .is_empty()
        );

        for incomplete in [
            json!({}),
            json!({ "permissions": null }),
            json!({ "permissions": [pending, { "request": {} }] }),
        ] {
            assert!(matches!(
                pending_permissions(&incomplete),
                Err(AgentError::Failed(message)) if message == "Invalid Copilot pending permission snapshot."
            ));
        }
    }

    #[test]
    fn the_managed_command_preserves_human_and_one_time_requirements_on_restore() {
        let native = json!({
            "kind": "commands",
            "managedApprovalRequired": true,
            "canOfferSessionApproval": false,
            "commandIdentifiers": ["git"],
            "fullCommandText": "git status",
            "intention": "Read working tree state",
        });
        let approval = card("task", "request", &native, Some("turn".into()), "/work").unwrap();

        assert!(approval.requires_human);
        assert_eq!(approval.id, "copilot:task:request");
        assert_eq!(approval.detail.command.as_deref(), Some("git status"));
        assert_eq!(
            approval.decisions,
            [
                ApprovalDecision::Allow,
                ApprovalDecision::Deny,
                ApprovalDecision::DenyAndStop
            ]
        );
        assert!(requires_human(&json!({ "managedApprovalRequired": "true" })).is_err());
    }

    #[test]
    fn the_permission_receipt_identifies_the_actual_decision_maker() {
        assert_eq!(
            decision_context(ApprovalSource::Human),
            json!({
                "source": "human_response",
                "surface": "sdk",
                "outcome": "prompted_user",
                "responseCapability": "interactive",
            })
        );
        assert_eq!(
            decision_context(ApprovalSource::HostPolicy),
            json!({
                "source": "host_policy",
                "surface": "sdk",
                "outcome": "auto_approved",
            })
        );
    }

    #[test]
    fn persistent_grants_display_the_exact_tool_command_or_domain() {
        let mcp = json!({
            "kind": "mcp",
            "serverName": "caffold",
            "toolName": "read_task_history",
        });
        let approval = card("a", "1", &mcp, None, "/work").unwrap();
        assert_eq!(
            approval.detail.permissions[0].value,
            "caffold / read_task_history"
        );
        assert_eq!(scoped_grant(&mcp).unwrap().0, mcp);

        let shell = json!({
            "kind": "commands",
            "canOfferSessionApproval": true,
            "commandIdentifiers": ["git", "pwd"],
        });
        assert_eq!(
            scoped_grant(&shell).unwrap().0,
            json!({ "kind": "commands", "commandIdentifiers": ["git", "pwd"] })
        );
        let unscoped = json!({
            "kind": "commands",
            "canOfferSessionApproval": false,
            "commandIdentifiers": ["git"],
        });
        assert!(scoped_grant(&unscoped).is_none());

        let url = json!({
            "kind": "url",
            "url": "https://docs.github.com/en/copilot",
            "parentDomainPattern": "*.github.com",
        });
        let approval = card("a", "2", &url, None, "/work").unwrap();
        assert_eq!(approval.detail.permissions[0].value, "docs.github.com");
        assert!(approval.decisions.contains(&ApprovalDecision::AllowAlways));
        assert!(
            !approval
                .decisions
                .contains(&ApprovalDecision::AllowForSession)
        );

        assert_eq!(
            decision_context(ApprovalSource::Human)["source"],
            "human_response"
        );
        assert_eq!(
            decision_context(ApprovalSource::HostPolicy)["source"],
            "host_policy"
        );
    }
}
