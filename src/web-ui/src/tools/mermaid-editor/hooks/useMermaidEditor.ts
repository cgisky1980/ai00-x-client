/**
 * Mermaid editor state hook.
 * Manages core state: source code, UI panels, and loading state.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { MermaidEditorState } from '../types';
import { mermaidService } from '../services/MermaidService';

export interface UseMermaidEditorOptions {
  /** Initial source code. */
  initialSourceCode?: string;
  /** Enable auto validation. */
  autoValidate?: boolean;
  /** Debounce interval for auto validation (ms). */
  autoParseInterval?: number;
}

export interface UseMermaidEditorReturn {
  state: MermaidEditorState;
  actions: {
    setSourceCode: (sourceCode: string, immediate?: boolean) => void;
    setShowSourceEditor: (show: boolean) => void;
    setShowComponentLibrary: (show: boolean) => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
    reset: () => void;
    validateSourceCode: (sourceCode: string) => Promise<void>;
  };
  sourceCode: string;
  isDirty: boolean;
  isLoading: boolean;
  error: string | null;
  showSourceEditor: boolean;
  showComponentLibrary: boolean;
}

export function useMermaidEditor(options: UseMermaidEditorOptions = {}): UseMermaidEditorReturn {
  const {
    initialSourceCode,
    autoValidate = true,
    autoParseInterval = 300,
  } = options;

  const [state, setState] = useState<MermaidEditorState>({
    sourceCode: initialSourceCode || mermaidService.getDefaultTemplate(),
    isDirty: false,
    showSourceEditor: false,
    showComponentLibrary: false,
    isLoading: false,
    error: null,
  });

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const initialSourceCodeRef = useRef(initialSourceCode);

  useEffect(() => {
    initialSourceCodeRef.current = initialSourceCode;
  }, [initialSourceCode]);

  const validateSourceCode = useCallback(async (sourceCode: string) => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }));
      const isValid = await mermaidService.validateSourceCode(sourceCode);
      
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: isValid ? null : 'Diagram syntax error',
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Validation failed',
      }));
    }
  }, []);

  const debouncedValidate = useCallback((sourceCode: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      validateSourceCode(sourceCode);
    }, autoParseInterval);
  }, [validateSourceCode, autoParseInterval]);

  const setSourceCode = useCallback((sourceCode: string, immediate = false) => {
    const defaultTemplate = mermaidService.getDefaultTemplate();
    const baseCode = initialSourceCodeRef.current || defaultTemplate;
    
    setState(prev => ({
      ...prev,
      sourceCode,
      isDirty: sourceCode !== baseCode,
    }));

    if (autoValidate) {
      if (immediate) {
        validateSourceCode(sourceCode);
      } else {
        debouncedValidate(sourceCode);
      }
    }
  }, [autoValidate, debouncedValidate, validateSourceCode]);

  const setShowSourceEditor = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showSourceEditor: show }));
  }, []);

  const setShowComponentLibrary = useCallback((show: boolean) => {
    setState(prev => ({ ...prev, showComponentLibrary: show }));
  }, []);

  const setLoading = useCallback((loading: boolean) => {
    setState(prev => ({ ...prev, isLoading: loading }));
  }, []);

  const setError = useCallback((error: string | null) => {
    setState(prev => ({ ...prev, error }));
  }, []);

  const reset = useCallback(() => {
    const defaultTemplate = mermaidService.getDefaultTemplate();
    setState({
      sourceCode: defaultTemplate,
      isDirty: false,
      showSourceEditor: false,
      showComponentLibrary: false,
      isLoading: false,
      error: null,
    });
    
    if (autoValidate) {
      debouncedValidate(defaultTemplate);
    }
  }, [autoValidate, debouncedValidate]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const actions = useMemo(() => ({
    setSourceCode,
    setShowSourceEditor,
    setShowComponentLibrary,
    setLoading,
    setError,
    reset,
    validateSourceCode,
  }), [setSourceCode, setShowSourceEditor, setShowComponentLibrary, setLoading, setError, reset, validateSourceCode]);

  return {
    state,
    actions,
    sourceCode: state.sourceCode,
    isDirty: state.isDirty,
    isLoading: state.isLoading,
    error: state.error,
    showSourceEditor: state.showSourceEditor,
    showComponentLibrary: state.showComponentLibrary,
  };
}

// Legacy alias export for migration.
export { useMermaidEditor as useMermaidEditorSimple };
