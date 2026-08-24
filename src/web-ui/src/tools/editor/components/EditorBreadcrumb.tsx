/** File path breadcrumb with a dropdown for quick navigation.
 * v0.13：浮层收敛至 DS Popover（.ds-popover，Radix 定位/外点关闭/ESC）。 */

import React, { useMemo, useCallback, useState } from 'react';
import { ChevronRight, File, Folder, Code, Loader2, ArrowLeft } from 'lucide-react';
import { getFileIconType } from '@/tools/file-system/utils/fileIcons';
import { workspaceAPI } from '@/infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { Tooltip, Popover, PopoverTrigger, PopoverContent } from '@/component-library';
import './EditorBreadcrumb.scss';

const log = createLogger('EditorBreadcrumb');

export interface EditorBreadcrumbProps {
  /** Full file path */
  filePath: string;
  /** Workspace path (for calculating relative path) */
  workspacePath?: string;
  /** Custom class name */
  className?: string;
}

interface PathSegment {
  name: string;
  fullPath: string;
  isFile: boolean;
}

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** Get icon component based on file name */
const getFileIconComponent = (fileName: string, size: number = 12): React.ReactElement => {
  const iconType = getFileIconType({ name: fileName, isDirectory: false } as any);

  switch (iconType) {
    case 'javascript':
    case 'typescript':
    case 'react':
    case 'vue':
    case 'python':
    case 'rust':
    case 'go':
    case 'java':
    case 'c-cpp':
    case 'html':
    case 'css':
    case 'sass':
    case 'code':
      return <Code size={size} />;
    default:
      return <File size={size} />;
  }
};

/** Get directory name from path */
const getDirectoryName = (path: string): string => {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
};

/** Get parent directory path */
const getParentPath = (path: string): string | null => {
  const normalized = path.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return normalized.substring(0, lastSlash);
};

export const EditorBreadcrumb: React.FC<EditorBreadcrumbProps> = ({
  filePath,
  workspacePath,
  className = '',
}) => {
  // Dropdown menu state
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [dropdownItems, setDropdownItems] = useState<FileItem[]>([]);
  const [dropdownLoading, setDropdownLoading] = useState(false);
  const [currentDirPath, setCurrentDirPath] = useState<string>('');
  const [initialDirPath, setInitialDirPath] = useState<string>('');

  // Parse path into segments
  const segments = useMemo<PathSegment[]>(() => {
    if (!filePath) return [];

    const normalizedPath = filePath.replace(/\\/g, '/');
    let relativePath = normalizedPath;
    const normalizedWorkspace = workspacePath ? workspacePath.replace(/\\/g, '/') : '';

    if (normalizedWorkspace) {
      if (normalizedPath.toLowerCase().startsWith(normalizedWorkspace.toLowerCase())) {
        relativePath = normalizedPath.slice(normalizedWorkspace.length).replace(/^\//, '');
      }
    }

    const parts = relativePath.split('/').filter(Boolean);
    if (parts.length === 0) return [];

    const result: PathSegment[] = [];

    // Add root directory as first level
    if (normalizedWorkspace) {
      const rootName = normalizedWorkspace.split('/').filter(Boolean).pop() || 'root';
      result.push({
        name: rootName,
        fullPath: normalizedWorkspace,
        isFile: false,
      });
    }

    let currentPath = normalizedWorkspace;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      result.push({
        name: part,
        fullPath: currentPath,
        isFile: i === parts.length - 1,
      });
    }

    return result;
  }, [filePath, workspacePath]);

  // Load directory contents
  const loadDirectoryContents = useCallback(async (dirPath: string) => {
    setDropdownLoading(true);
    setCurrentDirPath(dirPath);
    try {
      const fileTree = await workspaceAPI.getFileTree(dirPath, 1);
      const rootNode = fileTree?.[0];
      const children = rootNode?.children || [];

      const items: FileItem[] = children
        .filter((entry: any) => {
          const name = entry.name || '';
          return !name.startsWith('.') &&
                 !['node_modules', 'target', 'dist', 'build', '__pycache__', '.git'].includes(name);
        })
        .map((entry: any) => ({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory || false,
        }));

      setDropdownItems(items);
    } catch (error) {
      log.error('Failed to load directory', error);
      setDropdownItems([]);
    } finally {
      setDropdownLoading(false);
    }
  }, []);

  // Open dropdown for a segment
  const handleSegmentOpen = useCallback((segment: PathSegment) => {
    setOpenDropdown(segment.fullPath);

    const dirPath = segment.isFile
      ? segment.fullPath.substring(0, segment.fullPath.lastIndexOf('/'))
      : segment.fullPath;

    setInitialDirPath(dirPath);
    loadDirectoryContents(dirPath);
  }, [loadDirectoryContents]);

  // Handle popover open change (open from trigger / close from outside/esc)
  const handleOpenChange = useCallback((open: boolean, segment: PathSegment) => {
    if (open) {
      handleSegmentOpen(segment);
    } else {
      setOpenDropdown(null);
    }
  }, [handleSegmentOpen]);

  // Handle dropdown item selection
  const handleDropdownSelect = useCallback(async (item: FileItem) => {
    if (item.isDirectory) {
      loadDirectoryContents(item.path);
    } else {
      setOpenDropdown(null);

      const { fileTabManager } = await import('@/shared/services/FileTabManager');
      fileTabManager.openFile({
        filePath: item.path,
        fileName: item.name,
        workspacePath
      });
    }
  }, [loadDirectoryContents, workspacePath]);

  const handleGoBack = useCallback(() => {
    const parentPath = getParentPath(currentDirPath);
    if (parentPath) {
      loadDirectoryContents(parentPath);
    }
  }, [currentDirPath, loadDirectoryContents]);

  if (segments.length === 0) {
    return null;
  }

  const maxVisibleSegments = 6;
  let displaySegments: (PathSegment | { name: string; isEllipsis: true })[] = segments;

  if (segments.length > maxVisibleSegments) {
    displaySegments = [
      segments[0],
      { name: '…', isEllipsis: true },
      ...segments.slice(-4)
    ];
  }

  // Sort: directories first, then by name
  const sortedItems = [...dropdownItems].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  // Check if we can go back to parent
  const canGoBack = currentDirPath !== initialDirPath;
  const currentDirName = getDirectoryName(currentDirPath);

  return (
    <nav className={`editor-breadcrumb ${className}`}>
      {displaySegments.map((segment, index) => {
        const isEllipsis = 'isEllipsis' in segment && segment.isEllipsis;
        const pathSegment = segment as PathSegment;
        const isDropdownOpen = openDropdown === pathSegment.fullPath;

        return (
          <React.Fragment key={isEllipsis ? 'ellipsis' : pathSegment.fullPath}>
            {index > 0 && (
              <ChevronRight
                size={10}
                className="editor-breadcrumb__separator"
              />
            )}

            {isEllipsis ? (
              <span className="editor-breadcrumb__item editor-breadcrumb__item--ellipsis">
                {segment.name}
              </span>
            ) : (
              <Popover
                open={isDropdownOpen}
                onOpenChange={(open) => handleOpenChange(open, pathSegment)}
              >
                <Tooltip content={pathSegment.fullPath} placement="bottom">
                  <PopoverTrigger asChild>
                    <span
                      className={`editor-breadcrumb__item ${
                        pathSegment.isFile
                          ? 'editor-breadcrumb__item--file'
                          : 'editor-breadcrumb__item--folder'
                      } editor-breadcrumb__item--clickable ${isDropdownOpen ? 'editor-breadcrumb__item--active' : ''}`}
                    >
                      <span className="editor-breadcrumb__item-icon">
                        {pathSegment.isFile ? (
                          getFileIconComponent(pathSegment.name)
                        ) : (
                          <Folder size={12} />
                        )}
                      </span>
                      <span className="editor-breadcrumb__item-text">
                        {pathSegment.name}
                      </span>
                    </span>
                  </PopoverTrigger>
                </Tooltip>

                {isDropdownOpen && (
                  <PopoverContent
                    align="start"
                    sideOffset={2}
                    className="editor-breadcrumb-dropdown"
                    data-no-penetrate
                  >
                    {canGoBack && (
                      <div className="editor-breadcrumb-dropdown__header">
                        <Tooltip content="Go to parent directory" placement="top">
                          <button
                            className="editor-breadcrumb-dropdown__back"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleGoBack();
                            }}
                          >
                            <ArrowLeft size={12} />
                          </button>
                        </Tooltip>
                        <Tooltip content={currentDirPath} placement="top">
                          <span className="editor-breadcrumb-dropdown__title">
                            {currentDirName}
                          </span>
                        </Tooltip>
                      </div>
                    )}

                    {dropdownLoading ? (
                      <div className="editor-breadcrumb-dropdown__loading">
                        <Loader2 size={14} className="editor-breadcrumb-dropdown__spinner" />
                        <span>Loading...</span>
                      </div>
                    ) : sortedItems.length === 0 ? (
                      <div className="editor-breadcrumb-dropdown__empty">
                        Empty directory
                      </div>
                    ) : (
                      <ul className="editor-breadcrumb-dropdown__list">
                        {sortedItems.map((item) => {
                          const isCurrentFile = item.path.replace(/\\/g, '/') === filePath.replace(/\\/g, '/');
                          return (
                            <li
                              key={item.path}
                              className={`editor-breadcrumb-dropdown__item ${isCurrentFile ? 'editor-breadcrumb-dropdown__item--current' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDropdownSelect(item);
                              }}
                            >
                              <span className="editor-breadcrumb-dropdown__item-icon">
                                {item.isDirectory ? (
                                  <Folder size={14} />
                                ) : (
                                  getFileIconComponent(item.name, 14)
                                )}
                              </span>
                              <span className="editor-breadcrumb-dropdown__item-name">
                                {item.name}
                              </span>
                              {item.isDirectory && (
                                <ChevronRight size={12} className="editor-breadcrumb-dropdown__item-arrow" />
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </PopoverContent>
                )}
              </Popover>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
};

EditorBreadcrumb.displayName = 'EditorBreadcrumb';

export default EditorBreadcrumb;
