/**
 * Mermaid templates and presets.
 */

import { MermaidQuickTemplate, MermaidNodeTemplate, MermaidEdgeTemplate } from '../types';

// Starter templates for quick insert.
export const MERMAID_QUICK_TEMPLATES: MermaidQuickTemplate[] = [
  {
    id: 'simple-flowchart',
    name: 'Simple Flowchart',
    description: 'Basic flowchart template for beginners.',
    diagramType: 'flowchart',
    sourceCode: `flowchart TD
    A[Start] --> B[Process Data]
    B --> C{Success?}
    C -->|Yes| D[Save Result]
    C -->|No| E[Handle Error]
    D --> F[End]
    E --> F`
  },
  {
    id: 'ai-ide-architecture',
    name: 'AI IDE Architecture',
    description: 'AI-driven development environment architecture (advanced example).',
    diagramType: 'flowchart',
    sourceCode: `flowchart TD
subgraph ClientLayer[Client Layer]
    A[Web-based IDE UI]
    B[Desktop App<br>Electron-based]
    C[Mobile Companion App<br>Real-time notifications and review]
end

subgraph PresentationLayer[Presentation Layer]
    D[3D Architecture Visualization Engine]
    E[Multimodal Interaction Manager]
    F[Real-time Collaboration UI]
    G[Flow State Detection]
end

subgraph AILayer[AI Agent Layer]
    H[Coding Agent<br>Code generation and review]
    I[Architecture Agent<br>Rule validation and refactoring]
    J[Knowledge Agent<br>Graph building and retrieval]
    K[Collaboration Agent<br>Team coordination and recommendations]
end

subgraph CoreServicesLayer[Core Services Layer]
    L[Architecture Rules Engine]
    M[Knowledge Graph Service]
    N[Code Analysis and Transformation]
    O[Personalization Engine]
    P[Project Management Service]
    Q[Real-time Collaboration Service]
end

subgraph DataLayer[Data Layer]
    R[Project Knowledge Graph<br>Neo4j]
    S[Architecture Rules Store<br>PostgreSQL]
    T[Developer Profiles Store<br>MongoDB]
    U[Code Vector Store<br>Weaviate]
    V[Learning Resources Store<br>Elasticsearch]
end

subgraph InfrastructureLayer[Infrastructure Layer]
    W[Model Service Mesh<br>Multiple specialized AI models]
    X[Real-time Message Bus<br>Kafka]
    Y[Distributed Cache<br>Redis]
    Z[File Storage<br>S3-compatible storage]
end

%% Connections
A --> D
B --> D
C --> Q
D --> H
E --> H
E --> I
F --> Q
G --> O
H --> L
H --> N
I --> L
I --> M
J --> M
K --> P
K --> Q
L --> S
M --> R
M --> U
N --> U
O --> T
O --> V
P --> S
Q --> X
W --> H
W --> I
W --> J
W --> K
X --> Y`
  },
  {
    id: 'sequence-diagram',
    name: 'Sequence Diagram',
    description: 'Sequence interaction template.',
    diagramType: 'sequence',
    sourceCode: `sequenceDiagram
    participant User
    participant System
    participant Database
    
    User->>System: Send request
    System->>Database: Query data
    Database-->>System: Return results
    System-->>User: Return response`
  },
  {
    id: 'class-diagram',
    name: 'Class Diagram',
    description: 'Class relationship template.',
    diagramType: 'classDiagram',
    sourceCode: `classDiagram
    class Animal {
        +String name
        +int age
        +makeSound()
    }
    
    class Dog {
        +String breed
        +bark()
    }
    
    class Cat {
        +String color
        +meow()
    }
    
    Animal <|-- Dog
    Animal <|-- Cat`
  },
  {
    id: 'state-diagram',
    name: 'State Diagram',
    description: 'State transition template.',
    diagramType: 'stateDiagram',
    sourceCode: `stateDiagram-v2
    [*] --> Idle
    Idle --> Running : Start
    Running --> Paused : Pause
    Paused --> Running : Resume
    Running --> Stopped : Stop
    Stopped --> [*]`
  },
  {
    id: 'er-diagram',
    name: 'Entity Relationship Diagram',
    description: 'Database ER diagram template.',
    diagramType: 'erDiagram',
    sourceCode: `erDiagram
    USER ||--o{ ORDER : "Places order"
    ORDER ||--|{ LINE-ITEM : "Contains"
    CUSTOMER-ADDRESS ||--o{ ORDER : "Delivers to"
    PRODUCT ||--o{ LINE-ITEM : "In"
    
    USER {
        int id
        string name
        string email
    }
    
    ORDER {
        int id
        int user_id
        date order_date
    }
    
    PRODUCT {
        int id
        string name
        decimal price
    }`
  },
  {
    id: 'journey-diagram',
    name: 'User Journey Diagram',
    description: 'User experience journey template.',
    diagramType: 'journey',
    sourceCode: `journey
    title User Shopping Journey
    section Discover
      Visit website: 5: User
      Browse products: 3: User
      View details: 4: User
    section Purchase
      Add to cart: 2: User
      Checkout payment: 1: User
      Confirm order: 3: User
    section After Sales
      Receive product: 5: User
      Review product: 3: User`
  },
  {
    id: 'gantt-chart',
    name: 'Gantt Chart',
    description: 'Project schedule Gantt template.',
    diagramType: 'gantt',
    sourceCode: `gantt
    title Project Development Plan
    dateFormat  YYYY-MM-DD
    section Design Phase
    Requirements Analysis  :done,    des1, 2024-01-01,2024-01-15
    UI Design              :active,  des2, 2024-01-10, 30d
    section Development Phase
    Frontend Development   :         dev1, after des2, 45d
    Backend Development    :         dev2, 2024-01-20, 45d
    section Testing Phase
    Functional Testing     :         test1, after dev1, 15d
    System Testing         :         test2, after dev2, 10d`
  },
  {
    id: 'pie-chart',
    name: 'Pie Chart',
    description: 'Data distribution pie template.',
    diagramType: 'pie',
    sourceCode: `pie title Tech Stack Distribution
    "React" : 35
    "Vue" : 25
    "Angular" : 15
    "Svelte" : 10
    "Other" : 15`
  },
  {
    id: 'mindmap',
    name: 'Mind Map',
    description: 'Mind map template.',
    diagramType: 'mindmap',
    sourceCode: `mindmap
  root((Project Planning))
    Design
      Requirements Analysis
      Prototype Design
      UI Design
    Development
      Frontend Development
        React
        TypeScript
      Backend Development
        Node.js
        Database
    Testing
      Unit Testing
      Integration Testing
      Performance Testing
    Deployment
      CI/CD
      Monitoring
      Maintenance`
  },
  {
    id: 'git-graph',
    name: 'Git Branch Graph',
    description: 'Git branch flow template.',
    diagramType: 'gitgraph',
    sourceCode: `gitGraph
    commit id: "Initial commit"
    branch develop
    checkout develop
    commit id: "Develop feature A"
    commit id: "Refine feature A"
    checkout main
    merge develop
    commit id: "Release v1.0"
    branch hotfix
    checkout hotfix
    commit id: "Fix bug"
    checkout main
    merge hotfix
    commit id: "Release v1.1"`
  }
];

// Node templates for quick inserts.
export const MERMAID_NODE_TEMPLATES: MermaidNodeTemplate[] = [
  {
    id: 'rect',
    name: 'Rectangle',
    type: 'rect',
    icon: 'rect',
    defaultLabel: 'Process'
  },
  {
    id: 'circle',
    name: 'Circle',
    type: 'circle',
    icon: 'circle',
    defaultLabel: 'Start/End'
  },
  {
    id: 'diamond',
    name: 'Diamond',
    type: 'diamond',
    icon: 'diamond',
    defaultLabel: 'Decision'
  },
  {
    id: 'hexagon',
    name: 'Hexagon',
    type: 'hexagon',
    icon: 'hex',
    defaultLabel: 'Prepare'
  },
  {
    id: 'stadium',
    name: 'Stadium',
    type: 'stadium',
    icon: 'stadium',
    defaultLabel: 'Start/End'
  },
  {
    id: 'subroutine',
    name: 'Subroutine',
    type: 'subroutine',
    icon: 'subroutine',
    defaultLabel: 'Subroutine'
  },
  {
    id: 'cylinder',
    name: 'Cylinder',
    type: 'cylinder',
    icon: 'database',
    defaultLabel: 'Database'
  },
  {
    id: 'cloud',
    name: 'Cloud',
    type: 'cloud',
    icon: 'cloud',
    defaultLabel: 'Cloud Service'
  },
  {
    id: 'trapezoid',
    name: 'Trapezoid',
    type: 'trapezoid',
    icon: 'document',
    defaultLabel: 'Document'
  }
];

// Edge templates for connections.
export const MERMAID_EDGE_TEMPLATES: MermaidEdgeTemplate[] = [
  {
    id: 'solid-arrow',
    name: 'Solid Arrow',
    type: 'solid',
    arrow: 'arrow',
    icon: '→'
  },
  {
    id: 'solid-line',
    name: 'Solid Line',
    type: 'solid',
    arrow: 'none',
    icon: '─'
  },
  {
    id: 'dashed-arrow',
    name: 'Dashed Arrow',
    type: 'dashed',
    arrow: 'arrow',
    icon: '⇢'
  },
  {
    id: 'dashed-line',
    name: 'Dashed Line',
    type: 'dashed',
    arrow: 'none',
    icon: '┄'
  },
  {
    id: 'dotted-arrow',
    name: 'Dotted Arrow',
    type: 'dotted',
    arrow: 'arrow',
    icon: '⋯→'
  },
  {
    id: 'dotted-line',
    name: 'Dotted Line',
    type: 'dotted',
    arrow: 'none',
    icon: '⋯'
  },
  {
    id: 'thick-arrow',
    name: 'Thick Arrow',
    type: 'thick',
    arrow: 'arrow',
    icon: '⟹'
  },
  {
    id: 'thick-line',
    name: 'Thick Line',
    type: 'thick',
    arrow: 'none',
    icon: '━'
  }
];

// Preset color schemes.
export const MERMAID_COLOR_SCHEMES = {
  default: {
    name: 'Default',
    primary: '#0066cc',
    secondary: '#4d94ff',
    accent: '#ff6b35',
    background: '#ffffff',
    text: '#333333'
  },
  dark: {
    name: 'Dark',
    primary: '#4da6ff',
    secondary: '#0d47a1',
    accent: '#ff9800',
    background: '#1e1e1e',
    text: '#ffffff'
  },
  forest: {
    name: 'Forest',
    primary: '#2e7d32',
    secondary: '#4caf50',
    accent: '#ff5722',
    background: '#f1f8e9',
    text: '#1b5e20'
  },
  ocean: {
    name: 'Ocean',
    primary: '#006064',
    secondary: '#00acc1',
    accent: '#ff7043',
    background: '#e0f2f1',
    text: '#004d40'
  },
  sunset: {
    name: 'Sunset',
    primary: '#e65100',
    secondary: '#ff9800',
    accent: '#3f51b5',
    background: '#fff3e0',
    text: '#bf360c'
  }
};

// Default template for a diagram type.
export function getDefaultTemplate(diagramType: string): string {
  const template = MERMAID_QUICK_TEMPLATES.find(t => t.diagramType === diagramType);
  return template?.sourceCode || `${diagramType}
    A[Start] --> B[End]`;
}

export function generateNodeId(prefix: string = 'node'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
}

export function generateEdgeId(source: string, target: string): string {
  return `${source}_to_${target}_${Date.now()}`;
}

export function isValidNodeId(id: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(id);
}

export function formatSourceCode(sourceCode: string): string {
  return sourceCode
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

// Display names for diagram types.
export function getDiagramTypeDisplayName(type: string): string {
  const typeNames: Record<string, string> = {
    'flowchart': 'Flowchart',
    'sequence': 'Sequence Diagram',
    'classDiagram': 'Class Diagram',
    'stateDiagram': 'State Diagram',
    'erDiagram': 'Entity Relationship Diagram',
    'journey': 'User Journey',
    'gantt': 'Gantt Chart',
    'pie': 'Pie Chart',
    'mindmap': 'Mind Map',
    'timeline': 'Timeline',
    'gitgraph': 'Git Graph',
    'c4Context': 'C4 Context Diagram',
    'quadrant': 'Quadrant Chart'
  };
  
  return typeNames[type] || type;
}
