/// Events Layer
///
/// Independent event definition layer, providing:
/// - EventEmitter trait (event sending interface)
/// - Various event type definitions
/// - Event abstraction independent of platforms
pub mod agent;
pub mod audio_gen;
pub mod emitter;
pub mod types;

pub use agent::{
    AgentEvent, AgentEventEnvelope, AgentEventPriority, SubagentParentInfo, ToolEventData,
};
#[allow(deprecated)]
pub use agent::{AgenticEvent, AgenticEventEnvelope, AgenticEventPriority};
pub use audio_gen::AudioGenEvent;
pub use emitter::EventEmitter;
pub use types::*;
