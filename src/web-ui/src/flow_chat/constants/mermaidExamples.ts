/**
 * Mermaid interactive example data
 * Used to demonstrate the Mermaid dual-mode editor
 */
export const MERMAID_INTERACTIVE_EXAMPLE = {
  mermaid_code: `graph TD
    A[LOGIN_001<br/>User login entry] --> B[LOGIN_002<br/>Validate username]
    B --> C{LOGIN_003<br/>Username exists?}
    C -->|Yes| D[LOGIN_004<br/>Validate password]
    C -->|No| E[LOGIN_005<br/>Return error]
    D --> F{LOGIN_006<br/>Password correct?}
    F -->|Yes| G[LOGIN_007<br/>Generate token]
    F -->|No| H[LOGIN_008<br/>Password incorrect]
    G --> I[LOGIN_009<br/>Login success]
    E --> J[LOGIN_010<br/>Record failure log]
    H --> J
    
    %% Semantic styles - error nodes (red) and success node (green)
    style E fill:#fef2f2,stroke:#dc2626,stroke-width:2px,stroke-dasharray:5 3,color:#b91c1c
    style H fill:#fef2f2,stroke:#dc2626,stroke-width:2px,stroke-dasharray:5 3,color:#b91c1c
    style I fill:#f0fdf4,stroke:#16a34a,stroke-width:2px,color:#15803d`,
  title: 'Mermaid dual-mode demo - user login flow',
  session_id: `demo-${Date.now()}`,
  mode: 'interactive',
  allow_mode_switch: true,
  interactive_config: {
    node_metadata: {
      'A': {
        file_path: 'src/auth/login.rs',
        line_number: 45,
        label: 'User login entry',
        description: 'Handle login request and capture username and request_id',
        tooltip: 'Capture: username, request_id',
        category: 'entry',
        trace_id: 'TRACE_LOGIN_001'
      },
      'B': {
        file_path: 'src/auth/login.rs',
        line_number: 52,
        label: 'Validate username',
        description: 'Check username format and length',
        tooltip: 'Validate: username length > 3',
        category: 'process',
        trace_id: 'TRACE_LOGIN_002'
      },
      'C': {
        file_path: 'src/auth/login.rs',
        line_number: 58,
        label: 'Username exists?',
        description: 'Query the database to check whether the username exists',
        tooltip: 'DB query: SELECT * FROM users WHERE username = ?',
        category: 'decision',
        trace_id: 'TRACE_LOGIN_003'
      },
      'D': {
        file_path: 'src/auth/login.rs',
        line_number: 65,
        label: 'Validate password',
        description: 'Verify password hash with bcrypt',
        tooltip: 'Password verification: bcrypt::verify(password, hash)',
        category: 'process',
        trace_id: 'TRACE_LOGIN_004'
      },
      'E': {
        file_path: 'src/auth/login.rs',
        line_number: 72,
        label: 'Return error',
        description: 'Username not found, return error message',
        tooltip: 'Error: username not found',
        category: 'error',
        trace_id: 'TRACE_LOGIN_005'
      },
      'F': {
        file_path: 'src/auth/login.rs',
        line_number: 78,
        label: 'Password correct?',
        description: 'Check password verification result',
        tooltip: 'Check password verification result',
        category: 'decision',
        trace_id: 'TRACE_LOGIN_006'
      },
      'G': {
        file_path: 'src/auth/login.rs',
        line_number: 85,
        label: 'Generate token',
        description: 'Generate access token with JWT',
        tooltip: 'JWT generation: jwt::encode(payload, secret)',
        category: 'process',
        trace_id: 'TRACE_LOGIN_007'
      },
      'H': {
        file_path: 'src/auth/login.rs',
        line_number: 92,
        label: 'Password incorrect',
        description: 'Password verification failed, record attempt count',
        tooltip: 'Error: incorrect password, attempts +1',
        category: 'error',
        trace_id: 'TRACE_LOGIN_008'
      },
      'I': {
        file_path: 'src/auth/login.rs',
        line_number: 98,
        label: 'Login success',
        description: 'Return success response and token',
        tooltip: 'Success: return token and user info',
        category: 'exit',
        trace_id: 'TRACE_LOGIN_009'
      },
      'J': {
        file_path: 'src/auth/login.rs',
        line_number: 105,
        label: 'Record failure log',
        description: 'Write login failure log to file',
        tooltip: 'Log: record failure reason and timestamp',
        category: 'process',
        trace_id: 'TRACE_LOGIN_010'
      }
    },
    highlights: {
      executed: ['A', 'B', 'C'],
      failed: ['E'],
      current: 'D',
      warnings: []
    },
    enable_navigation: true,
    enable_tooltips: true
  }
};

