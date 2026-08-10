/**
 * Mermaid editor error boundary component
 */

import { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { i18nService } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { Button } from '@/component-library';
import './MermaidErrorBoundary.css';

const log = createLogger('MermaidErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: any;
}

export class MermaidErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error
    };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    log.error('Caught error', { errorInfo, error });
    this.setState({
      error,
      errorInfo
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const t = (key: string) => i18nService.t(`mermaid-editor:${key}`);
      
      return (
        <div className="mermaid-error-boundary">
          <div className="error-content">
            <div className="error-icon">
              <AlertTriangle size={48} color="#ef4444" />
            </div>
            <h3>{t('errorBoundary.title')}</h3>
            <p className="error-message">
              {this.state.error?.message?.split('\n')[0] || t('errorBoundary.defaultMessage')}
            </p>
            <div className="error-actions">
              <Button 
                variant="secondary"
                size="small"
                onClick={this.handleRetry}
              >
                <RefreshCw size={14} />
                {t('errorBoundary.retry')}
              </Button>
            </div>
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="error-details" style={{ marginTop: '12px' }}>
                <summary style={{ fontSize: '12px', color: '#666' }}>{t('errorBoundary.technicalDetails')}</summary>
                <pre style={{ 
                  fontSize: '11px', 
                  overflow: 'auto', 
                  maxHeight: '100px',
                  background: '#f5f5f5',
                  padding: '8px',
                  borderRadius: '4px'
                }}>
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default MermaidErrorBoundary;
