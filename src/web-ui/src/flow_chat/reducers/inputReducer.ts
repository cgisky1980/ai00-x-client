/**
 * Input state reducer
 */

export interface InputState {
  value: string;
  /** Expanded to full height */
  isExpanded: boolean;
  /** Active state when expanding from collapsed */
  isActive: boolean;
}

export type InputAction =
  | { type: 'SET_VALUE'; payload: string }
  | { type: 'CLEAR_VALUE' }
  | { type: 'TOGGLE_EXPAND' }
  | { type: 'SET_EXPANDED'; payload: boolean }
  | { type: 'ACTIVATE' }
  | { type: 'DEACTIVATE' };

export const initialInputState: InputState = {
  value: '',
  isExpanded: false,
  isActive: true,
};

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'SET_VALUE':
      return { ...state, value: action.payload };
      
    case 'CLEAR_VALUE':
      return { ...state, value: '' };
      
    case 'TOGGLE_EXPAND':
      return { ...state, isExpanded: !state.isExpanded };
      
    case 'SET_EXPANDED':
      return { ...state, isExpanded: action.payload };
      
    case 'ACTIVATE':
      return { ...state, isActive: true };
      
    case 'DEACTIVATE':
      return state;
      
    default:
      return state;
  }
}
