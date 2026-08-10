/**
 * Mermaid component library data.
 */

import { MermaidComponentCategory } from '../types';

/**
 * Returns localized component categories.
 * @param t Translation function.
 */
export const getComponentCategories = (t: (key: string) => string): MermaidComponentCategory[] => [
  {
    id: 'nodes',
    name: t('componentLibrary.categories.nodes'),
    components: [
      {
        id: 'rect-node',
        name: t('componentLibrary.components.rectNode'),
        category: 'nodes',
        code: 'A[Node]',
        description: t('componentLibrary.components.rectNodeDesc')
      },
      {
        id: 'round-node',
        name: t('componentLibrary.components.roundNode'),
        category: 'nodes',
        code: 'B(Node)',
        description: t('componentLibrary.components.roundNodeDesc')
      },
      {
        id: 'circle-node',
        name: t('componentLibrary.components.circleNode'),
        category: 'nodes',
        code: 'C((Node))',
        description: t('componentLibrary.components.circleNodeDesc')
      },
      {
        id: 'diamond-node',
        name: t('componentLibrary.components.diamondNode'),
        category: 'nodes',
        code: 'D{Node}',
        description: t('componentLibrary.components.diamondNodeDesc')
      },
      {
        id: 'hexagon-node',
        name: t('componentLibrary.components.hexagonNode'),
        category: 'nodes',
        code: 'E{{Node}}',
        description: t('componentLibrary.components.hexagonNodeDesc')
      }
    ]
  },
  {
    id: 'connections',
    name: t('componentLibrary.categories.connections'),
    components: [
      {
        id: 'arrow-line',
        name: t('componentLibrary.components.arrowLine'),
        category: 'connections',
        code: 'A --> B',
        description: t('componentLibrary.components.arrowLineDesc')
      },
      {
        id: 'labeled-arrow',
        name: t('componentLibrary.components.labeledArrow'),
        category: 'connections',
        code: 'A -->|Label| B',
        description: t('componentLibrary.components.labeledArrowDesc')
      },
      {
        id: 'dotted-line',
        name: t('componentLibrary.components.dottedLine'),
        category: 'connections',
        code: 'A -.-> B',
        description: t('componentLibrary.components.dottedLineDesc')
      },
      {
        id: 'thick-line',
        name: t('componentLibrary.components.thickLine'),
        category: 'connections',
        code: 'A ==> B',
        description: t('componentLibrary.components.thickLineDesc')
      },
      {
        id: 'plain-line',
        name: t('componentLibrary.components.plainLine'),
        category: 'connections',
        code: 'A --- B',
        description: t('componentLibrary.components.plainLineDesc')
      }
    ]
  },
  {
    id: 'templates',
    name: t('componentLibrary.categories.templates'),
    components: [
      {
        id: 'simple-flow',
        name: t('componentLibrary.components.simpleFlow'),
        category: 'templates',
        code: `flowchart TD
    A[Start] --> B[Process]
    B --> C{Success?}
    C -->|Yes| D[Save]
    C -->|No| E[Error]
    D --> F[End]
    E --> F`,
        description: t('componentLibrary.components.simpleFlowDesc')
      },
      {
        id: 'ai-ide-architecture',
        name: t('componentLibrary.components.aiIdeArchitecture'),
        category: 'templates',
        code: `flowchart TD
subgraph ClientLayer[Client Layer]
    A[Web IDE]
    B[Desktop App]
    C[Mobile App]
end

subgraph PresentationLayer[Presentation Layer]
    D[3D Visualization]
    E[Multimodal Interaction]
    F[Real-time Collaboration]
    G[Flow State Detection]
end

subgraph AILayer[AI Agent Layer]
    H[Coding Agent]
    I[Architecture Agent]
    J[Knowledge Agent]
    K[Collaboration Agent]
end

subgraph CoreServicesLayer[Core Services]
    L[Rule Engine]
    M[Knowledge Graph]
    N[Code Analysis]
    O[Personalization]
    P[Project Management]
    Q[Collaboration Service]
end

subgraph DataLayer[Data Layer]
    R[Knowledge Graph DB]
    S[Rule Database]
    T[User Profiles]
    U[Vector Store]
    V[Resource Library]
end

subgraph InfrastructureLayer[Infrastructure]
    W[Model Mesh]
    X[Message Bus]
    Y[Cache]
    Z[File Storage]
end

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
X --> Y`,
        description: t('componentLibrary.components.aiIdeArchitectureDesc')
      },
      {
        id: 'parallel-flow',
        name: t('componentLibrary.components.parallelFlow'),
        category: 'templates',
        code: `flowchart TD
    A[Start] --> B[Fork]
    B --> C[Task 1]
    B --> D[Task 2]
    C --> E[Join]
    D --> E
    E --> F[End]`,
        description: t('componentLibrary.components.parallelFlowDesc')
      }
    ]
  }
];

// Default export for backward compatibility (English fallback).
export const componentCategories: MermaidComponentCategory[] = getComponentCategories((key: string) => {
  // Simple fallback translation map.
  const fallbackMap: Record<string, string> = {
    'componentLibrary.categories.nodes': 'Nodes',
    'componentLibrary.categories.connections': 'Connections',
    'componentLibrary.categories.templates': 'Templates',
    'componentLibrary.components.rectNode': 'Rectangle Node',
    'componentLibrary.components.rectNodeDesc': 'Basic rectangle node',
    'componentLibrary.components.roundNode': 'Rounded Rectangle',
    'componentLibrary.components.roundNodeDesc': 'Rounded rectangle node',
    'componentLibrary.components.circleNode': 'Circle Node',
    'componentLibrary.components.circleNodeDesc': 'Circle node',
    'componentLibrary.components.diamondNode': 'Diamond Node',
    'componentLibrary.components.diamondNodeDesc': 'Decision diamond node',
    'componentLibrary.components.hexagonNode': 'Hexagon Node',
    'componentLibrary.components.hexagonNodeDesc': 'Hexagon node',
    'componentLibrary.components.arrowLine': 'Arrow Connection',
    'componentLibrary.components.arrowLineDesc': 'Basic arrow connection',
    'componentLibrary.components.labeledArrow': 'Labeled Arrow',
    'componentLibrary.components.labeledArrowDesc': 'Arrow connection with label',
    'componentLibrary.components.dottedLine': 'Dotted Connection',
    'componentLibrary.components.dottedLineDesc': 'Dotted arrow connection',
    'componentLibrary.components.thickLine': 'Thick Connection',
    'componentLibrary.components.thickLineDesc': 'Thick arrow connection',
    'componentLibrary.components.plainLine': 'Plain Line',
    'componentLibrary.components.plainLineDesc': 'Plain line without arrow',
    'componentLibrary.components.simpleFlow': 'Simple Flow',
    'componentLibrary.components.simpleFlowDesc': 'Basic flowchart template with decision branch',
    'componentLibrary.components.aiIdeArchitecture': 'AI IDE Architecture',
    'componentLibrary.components.aiIdeArchitectureDesc': 'AI-driven intelligent development environment architecture',
    'componentLibrary.components.parallelFlow': 'Parallel Flow',
    'componentLibrary.components.parallelFlowDesc': 'Parallel processing flow',
  };
  return fallbackMap[key] || key;
});
