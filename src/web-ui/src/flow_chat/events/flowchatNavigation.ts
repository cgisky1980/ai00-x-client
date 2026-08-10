/**
 * Shared navigation events for FlowChat viewport movement and focus.
 */

export const FLOWCHAT_FOCUS_ITEM_EVENT = 'flowchat:focus-item';
export const FLOWCHAT_PIN_TURN_TO_TOP_EVENT = 'flowchat:pin-turn-to-top';

export type FlowChatPinTurnToTopSource = 'send-message';
export type FlowChatPinTurnToTopMode = 'transient' | 'sticky-latest';

export interface FlowChatFocusItemRequest {
  sessionId: string;
  turnIndex?: number;
  itemId?: string;
  source?: string;
}

export interface FlowChatPinTurnToTopRequest {
  sessionId: string;
  turnId: string;
  behavior?: ScrollBehavior;
  source?: FlowChatPinTurnToTopSource;
  pinMode?: FlowChatPinTurnToTopMode;
}
