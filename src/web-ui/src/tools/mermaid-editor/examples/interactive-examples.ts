/**
 * Mermaid interactive examples and test cases.
 */

import { MermaidPanelData, NodeMetadata, HighlightState } from '../types/MermaidPanelTypes';

// Example 1: login flow debugging
export const loginFlowExample: MermaidPanelData = {
  mermaid_code: `graph TD
    A[LOGIN_001<br/>Login entry] --> B[LOGIN_002<br/>Validate username]
    B --> C{LOGIN_003<br/>Username exists?}
    C -->|Yes| D[LOGIN_004<br/>Validate password]
    C -->|No| E[LOGIN_005<br/>Return error]
    D --> F{LOGIN_006<br/>Password correct?}
    F -->|Yes| G[LOGIN_007<br/>Generate token]
    F -->|No| H[LOGIN_008<br/>Invalid password]
    G --> I[LOGIN_009<br/>Login success]
    E --> J[LOGIN_010<br/>Log failure]
    H --> J`,
  title: 'User login flow - Debug session',
  session_id: 'debug-login-001',
  mode: 'interactive',
  allow_mode_switch: true,
  interactive_config: {
    node_metadata: {
      'LOGIN_001': {
        file_path: 'src/auth/login.rs',
        line_number: 45,
        label: 'Login entry',
        description: 'Handle login request and capture username and request_id.',
        tooltip: 'Captured: username, request_id',
        category: 'entry',
        trace_id: 'TRACE_LOGIN_001'
      },
      'LOGIN_002': {
        file_path: 'src/auth/login.rs',
        line_number: 52,
        label: 'Validate username',
        description: 'Check username format and length.',
        tooltip: 'Check: username length > 3',
        category: 'process',
        trace_id: 'TRACE_LOGIN_002'
      },
      'LOGIN_003': {
        file_path: 'src/auth/login.rs',
        line_number: 58,
        label: 'Username exists?',
        description: 'Query the database to check if the username exists.',
        tooltip: 'Database query: SELECT * FROM users WHERE username = ?',
        category: 'decision',
        trace_id: 'TRACE_LOGIN_003'
      },
      'LOGIN_004': {
        file_path: 'src/auth/login.rs',
        line_number: 65,
        label: 'Validate password',
        description: 'Verify the password hash with bcrypt.',
        tooltip: 'Password verification: bcrypt::verify(password, hash)',
        category: 'process',
        trace_id: 'TRACE_LOGIN_004'
      },
      'LOGIN_005': {
        file_path: 'src/auth/login.rs',
        line_number: 72,
        label: 'Return error',
        description: 'Username not found; return an error.',
        tooltip: 'Error: username not found',
        category: 'error',
        trace_id: 'TRACE_LOGIN_005'
      },
      'LOGIN_006': {
        file_path: 'src/auth/login.rs',
        line_number: 78,
        label: 'Password correct?',
        description: 'Check the password verification result.',
        tooltip: 'Password verification result check',
        category: 'decision',
        trace_id: 'TRACE_LOGIN_006'
      },
      'LOGIN_007': {
        file_path: 'src/auth/login.rs',
        line_number: 85,
        label: 'Generate token',
        description: 'Generate an access token with JWT.',
        tooltip: 'JWT generation: jwt::encode(payload, secret)',
        category: 'process',
        trace_id: 'TRACE_LOGIN_007'
      },
      'LOGIN_008': {
        file_path: 'src/auth/login.rs',
        line_number: 92,
        label: 'Invalid password',
        description: 'Password verification failed; record attempt count.',
        tooltip: 'Error: invalid password, attempts +1',
        category: 'error',
        trace_id: 'TRACE_LOGIN_008'
      },
      'LOGIN_009': {
        file_path: 'src/auth/login.rs',
        line_number: 98,
        label: 'Login success',
        description: 'Return a success response and token.',
        tooltip: 'Success: return token and user info',
        category: 'exit',
        trace_id: 'TRACE_LOGIN_009'
      },
      'LOGIN_010': {
        file_path: 'src/auth/login.rs',
        line_number: 105,
        label: 'Log failure',
        description: 'Write login failure details to a log file.',
        tooltip: 'Log: failure reason and timestamp',
        category: 'process',
        trace_id: 'TRACE_LOGIN_010'
      }
    },
    highlights: {
      executed: [],
      failed: [],
      current: null,
      warnings: []
    },
    enable_navigation: true,
    enable_tooltips: true
  }
};

// Example 2: API request handling flow
export const apiRequestExample: MermaidPanelData = {
  mermaid_code: `graph LR
    A[API_001<br/>Receive request] --> B[API_002<br/>Parse JSON]
    B --> C[API_003<br/>Validate parameters]
    C --> D{API_004<br/>Parameters valid?}
    D -->|Yes| E[API_005<br/>Query database]
    D -->|No| F[API_006<br/>Return 400 error]
    E --> G{API_007<br/>Data exists?}
    G -->|Yes| H[API_008<br/>Process business logic]
    G -->|No| I[API_009<br/>Return 404 error]
    H --> J[API_010<br/>Return 200 success]`,
  title: 'API request handling flow',
  session_id: 'debug-api-001',
  mode: 'interactive',
  allow_mode_switch: true,
  interactive_config: {
    node_metadata: {
      'API_001': {
        file_path: 'src/api/handler.rs',
        line_number: 23,
        label: 'Receive request',
        description: 'Receive the HTTP request and extract parameters.',
        tooltip: 'HTTP request handling',
        category: 'entry',
        trace_id: 'TRACE_API_001'
      },
      'API_002': {
        file_path: 'src/api/handler.rs',
        line_number: 28,
        label: 'Parse JSON',
        description: 'Parse JSON data from the request body.',
        tooltip: 'JSON parse: serde_json::from_str',
        category: 'process',
        trace_id: 'TRACE_API_002'
      },
      'API_003': {
        file_path: 'src/api/handler.rs',
        line_number: 35,
        label: 'Validate parameters',
        description: 'Validate the required parameters.',
        tooltip: 'Parameter validation: required fields',
        category: 'process',
        trace_id: 'TRACE_API_003'
      },
      'API_004': {
        file_path: 'src/api/handler.rs',
        line_number: 42,
        label: 'Parameters valid?',
        description: 'Check the validation result.',
        tooltip: 'Validation result check',
        category: 'decision',
        trace_id: 'TRACE_API_004'
      },
      'API_005': {
        file_path: 'src/api/handler.rs',
        line_number: 48,
        label: 'Query database',
        description: 'Query the database by parameters.',
        tooltip: 'Database query: SELECT * FROM table WHERE id = ?',
        category: 'process',
        trace_id: 'TRACE_API_005'
      },
      'API_006': {
        file_path: 'src/api/handler.rs',
        line_number: 55,
        label: 'Return 400 error',
        description: 'Invalid parameters; return HTTP 400.',
        tooltip: 'HTTP 400: Bad Request',
        category: 'error',
        trace_id: 'TRACE_API_006'
      },
      'API_007': {
        file_path: 'src/api/handler.rs',
        line_number: 62,
        label: 'Data exists?',
        description: 'Check the query result.',
        tooltip: 'Query result check',
        category: 'decision',
        trace_id: 'TRACE_API_007'
      },
      'API_008': {
        file_path: 'src/api/handler.rs',
        line_number: 68,
        label: 'Process business logic',
        description: 'Execute the business logic.',
        tooltip: 'Business logic processing',
        category: 'process',
        trace_id: 'TRACE_API_008'
      },
      'API_009': {
        file_path: 'src/api/handler.rs',
        line_number: 75,
        label: 'Return 404 error',
        description: 'Data not found; return HTTP 404.',
        tooltip: 'HTTP 404: Not Found',
        category: 'error',
        trace_id: 'TRACE_API_009'
      },
      'API_010': {
        file_path: 'src/api/handler.rs',
        line_number: 82,
        label: 'Return 200 success',
        description: 'Success; return HTTP 200.',
        tooltip: 'HTTP 200: OK',
        category: 'exit',
        trace_id: 'TRACE_API_010'
      }
    },
    highlights: {
      executed: [],
      failed: [],
      current: null,
      warnings: []
    },
    enable_navigation: true,
    enable_tooltips: true
  }
};

// Example 3: database transaction handling
export const databaseTransactionExample: MermaidPanelData = {
  mermaid_code: `graph TD
    A[DB_001<br/>Start transaction] --> B[DB_002<br/>Lock tables]
    B --> C[DB_003<br/>Execute query 1]
    C --> D[DB_004<br/>Execute query 2]
    D --> E{DB_005<br/>All queries succeeded?}
    E -->|Yes| F[DB_006<br/>Commit transaction]
    E -->|No| G[DB_007<br/>Rollback transaction]
    F --> H[DB_008<br/>Release locks]
    G --> H
    H --> I[DB_009<br/>Return result]`,
  title: 'Database transaction flow',
  session_id: 'debug-db-001',
  mode: 'interactive',
  allow_mode_switch: true,
  interactive_config: {
    node_metadata: {
      'DB_001': {
        file_path: 'src/database/transaction.rs',
        line_number: 15,
        label: 'Start transaction',
        description: 'Start a database transaction.',
        tooltip: 'BEGIN TRANSACTION',
        category: 'entry',
        trace_id: 'TRACE_DB_001'
      },
      'DB_002': {
        file_path: 'src/database/transaction.rs',
        line_number: 22,
        label: 'Lock tables',
        description: 'Acquire table-level locks.',
        tooltip: 'LOCK TABLE users WRITE',
        category: 'process',
        trace_id: 'TRACE_DB_002'
      },
      'DB_003': {
        file_path: 'src/database/transaction.rs',
        line_number: 28,
        label: 'Execute query 1',
        description: 'Run the first database query.',
        tooltip: 'SELECT * FROM users WHERE id = ?',
        category: 'process',
        trace_id: 'TRACE_DB_003'
      },
      'DB_004': {
        file_path: 'src/database/transaction.rs',
        line_number: 35,
        label: 'Execute query 2',
        description: 'Run the second database query.',
        tooltip: 'UPDATE users SET last_login = NOW() WHERE id = ?',
        category: 'process',
        trace_id: 'TRACE_DB_004'
      },
      'DB_005': {
        file_path: 'src/database/transaction.rs',
        line_number: 42,
        label: 'All queries succeeded?',
        description: 'Check whether all queries succeeded.',
        tooltip: 'Check query results',
        category: 'decision',
        trace_id: 'TRACE_DB_005'
      },
      'DB_006': {
        file_path: 'src/database/transaction.rs',
        line_number: 48,
        label: 'Commit transaction',
        description: 'Commit the database transaction.',
        tooltip: 'COMMIT',
        category: 'process',
        trace_id: 'TRACE_DB_006'
      },
      'DB_007': {
        file_path: 'src/database/transaction.rs',
        line_number: 55,
        label: 'Rollback transaction',
        description: 'Roll back the database transaction.',
        tooltip: 'ROLLBACK',
        category: 'error',
        trace_id: 'TRACE_DB_007'
      },
      'DB_008': {
        file_path: 'src/database/transaction.rs',
        line_number: 62,
        label: 'Release locks',
        description: 'Release table-level locks.',
        tooltip: 'UNLOCK TABLES',
        category: 'process',
        trace_id: 'TRACE_DB_008'
      },
      'DB_009': {
        file_path: 'src/database/transaction.rs',
        line_number: 68,
        label: 'Return result',
        description: 'Return the transaction result.',
        tooltip: 'Return the result to the caller',
        category: 'exit',
        trace_id: 'TRACE_DB_009'
      }
    },
    highlights: {
      executed: [],
      failed: [],
      current: null,
      warnings: []
    },
    enable_navigation: true,
    enable_tooltips: true
  }
};

// Test scenario: simulated execution flow
export const createTestScenario = (baseExample: MermaidPanelData, scenario: 'success' | 'failure' | 'partial'): MermaidPanelData => {
  const example = JSON.parse(JSON.stringify(baseExample)) as MermaidPanelData;
  
  if (!example.interactive_config) return example;

  const nodeIds = Object.keys(example.interactive_config.node_metadata);
  
  switch (scenario) {
    case 'success':
      // All nodes succeed.
      example.interactive_config.highlights = {
        executed: nodeIds,
        failed: [],
        current: null,
        warnings: []
      };
      break;
      
    case 'failure':
      // Partial failure.
      const midPoint = Math.floor(nodeIds.length / 2);
      example.interactive_config.highlights = {
        executed: nodeIds.slice(0, midPoint),
        failed: nodeIds.slice(midPoint),
        current: null,
        warnings: []
      };
      break;
      
    case 'partial':
      // Partial execution with warnings.
      const executedCount = Math.floor(nodeIds.length * 0.7);
      example.interactive_config.highlights = {
        executed: nodeIds.slice(0, executedCount),
        failed: nodeIds.slice(executedCount, executedCount + 1),
        current: nodeIds[executedCount + 1] || null,
        warnings: nodeIds.slice(executedCount + 2, executedCount + 3)
      };
      break;
  }

  return example;
};

// Test case for dynamic highlight updates
export const createDynamicUpdateTest = (baseExample: MermaidPanelData): Array<{ step: number; highlights: HighlightState; description: string }> => {
  const nodeIds = Object.keys(baseExample.interactive_config?.node_metadata || {});
  
  return [
    {
      step: 1,
      highlights: {
        executed: [],
        failed: [],
        current: nodeIds[0],
        warnings: []
      },
      description: 'Start execution, current node: first node'
    },
    {
      step: 2,
      highlights: {
        executed: [nodeIds[0]],
        failed: [],
        current: nodeIds[1],
        warnings: []
      },
      description: 'First node completed, current node: second node'
    },
    {
      step: 3,
      highlights: {
        executed: [nodeIds[0], nodeIds[1]],
        failed: [],
        current: nodeIds[2],
        warnings: []
      },
      description: 'Second node completed, current node: third node'
    },
    {
      step: 4,
      highlights: {
        executed: [nodeIds[0], nodeIds[1], nodeIds[2]],
        failed: [nodeIds[3]],
        current: null,
        warnings: []
      },
      description: 'Third node completed, fourth node failed'
    },
    {
      step: 5,
      highlights: {
        executed: [nodeIds[0], nodeIds[1], nodeIds[2]],
        failed: [nodeIds[3]],
        current: null,
        warnings: [nodeIds[4]]
      },
      description: 'Flow finished, fifth node has a warning'
    }
  ];
};

// Export all examples
export const interactiveExamples = {
  loginFlow: loginFlowExample,
  apiRequest: apiRequestExample,
  databaseTransaction: databaseTransactionExample,
  createTestScenario,
  createDynamicUpdateTest
};
