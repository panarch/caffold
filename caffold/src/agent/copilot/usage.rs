//! Call spending and current context occupancy are independent SDK observations.
use crate::agent::{TokenCount, TokenUsage};
use copilot_sdk::rpc::UsageGetMetricsResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub(super) struct Usage {
    pub total: Counters,
    pub last: Counters,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub(super) struct Counters {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    reasoning: u64,
}

impl Counters {
    pub fn from_call(data: &Value) -> Option<Self> {
        Some(Self {
            input: data["inputTokens"].as_u64()?,
            output: data["outputTokens"].as_u64()?,
            cache_read: data["cacheReadTokens"].as_u64().unwrap_or(0),
            cache_write: data["cacheWriteTokens"].as_u64().unwrap_or(0),
            reasoning: data["reasoningTokens"].as_u64().unwrap_or(0),
        })
    }
    pub fn from_metrics(metrics: &UsageGetMetricsResult) -> Self {
        let mut total = Self::default();
        for model in metrics.model_metrics.values() {
            let reported = &model.usage;
            total.add(Self {
                input: reported.input_tokens.max(0) as u64,
                output: reported.output_tokens.max(0) as u64,
                cache_read: reported.cache_read_tokens.max(0) as u64,
                cache_write: reported.cache_write_tokens.max(0) as u64,
                reasoning: reported.reasoning_tokens.unwrap_or(0).max(0) as u64,
            });
        }
        total
    }
    pub fn add(&mut self, other: Self) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.reasoning += other.reasoning;
    }
    fn normalized(self) -> TokenCount {
        TokenCount {
            total_tokens: self.input + self.output,
            input_tokens: self.input,
            output_tokens: self.output,
            cached_input_tokens: self.cache_read,
            cache_write_input_tokens: self.cache_write,
            reasoning_output_tokens: self.reasoning,
        }
    }
}
impl Usage {
    pub fn normalized(self, window: Option<u64>) -> TokenUsage {
        TokenUsage {
            total: self.total.normalized(),
            last: self.last.normalized(),
            model_context_window: window,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn summed_model_calls_keep_cache_and_reasoning_details_separate_from_context() {
        let mut usage = Usage::default();
        for call in [
            json!({"inputTokens":30,"outputTokens":4,"cacheReadTokens":12}),
            json!({"inputTokens":40,"outputTokens":8,"reasoningTokens":3}),
        ] {
            let counters = Counters::from_call(&call).unwrap();
            usage.total.add(counters);
            usage.last.add(counters);
        }
        let report = usage.normalized(None);
        assert_eq!(report.last.total_tokens, 82);
        assert_eq!(report.total.cached_input_tokens, 12);
        assert_eq!(report.last.reasoning_output_tokens, 3);
        assert_eq!(report.model_context_window, None);
        assert!(Counters::from_call(&json!({"cost":12})).is_none());
    }
}
