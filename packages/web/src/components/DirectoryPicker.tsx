import { useEffect, useState } from 'react';
import type { Api, DirectoryTreeNode } from '../api';
import { IconChevron, IconClose, IconFolder } from './icons';

interface DirectoryPickerProps {
  api: Api;
  roots: string[];
  selected: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function DirectoryPicker({ api, roots, selected, onSelect, onClose }: DirectoryPickerProps) {
  const [tree, setTree] = useState<DirectoryTreeNode[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Load directory trees for all roots
    Promise.all(roots.map((root) => api.directoryTree(root, 4)))
      .then(setTree)
      .catch((e) => setError(e instanceof Error ? e.message : '无法读取目录'));
  }, [roots, api]);

  const toggleExpanded = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };

  const filteredTree = tree?.map((node) => filterTree(node, search));

  const renderTree = (nodes: DirectoryTreeNode[] | undefined, depth = 0): React.ReactNode => {
    if (!nodes) return null;
    return (
      <>
        {nodes.map((node) => (
          <div key={node.path}>
            <div
              className="directory-item"
              style={{ paddingLeft: `${depth * 20}px` }}
              role="treeitem"
              aria-expanded={expanded.has(node.path)}
            >
              {node.children && node.children.length > 0 && (
                <button
                  className={`expand-btn${expanded.has(node.path) ? ' expanded' : ''}`}
                  onClick={() => toggleExpanded(node.path)}
                  aria-label={expanded.has(node.path) ? '收起' : '展开'}
                >
                  <IconChevron size={14} />
                </button>
              )}
              {!node.children && <span className="expand-btn-placeholder" />}
              <button
                className={`directory-btn${node.path === selected ? ' active' : ''}`}
                onClick={() => onSelect(node.path)}
              >
                <span className="dir-icon">
                  <IconFolder size={16} />
                </span>
                <span className="dir-name" title={node.path}>
                  {node.name}
                </span>
                {/* The full path only on the roots; below them the tree already says where things are. */}
                {depth === 0 && <span className="dir-path">{node.path}</span>}
              </button>
            </div>
            {expanded.has(node.path) && renderTree(node.children, depth + 1)}
          </div>
        ))}
      </>
    );
  };

  return (
    <div className="directory-picker-overlay" onClick={onClose}>
      <div className="directory-picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-header">
          <h3>在哪个目录里工作？</h3>
          <button className="close-btn" onClick={onClose} aria-label="关闭">
            <IconClose size={18} />
          </button>
        </div>

        <input
          type="text"
          className="picker-search"
          placeholder="搜索目录"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />

        {error && <div className="picker-error">{error}</div>}

        <div className="picker-tree">
          {tree === null ? <div className="picker-loading">正在读取目录…</div> : renderTree(filteredTree)}
        </div>

        <div className="picker-footer">
          <button className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={() => { onSelect(selected); onClose(); }}>
            用这个目录
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Filter tree nodes by search query. Returns new tree with only matching branches.
 */
function filterTree(node: DirectoryTreeNode, search: string): DirectoryTreeNode {
  const matches = node.name.toLowerCase().includes(search.toLowerCase());
  const filteredChildren = node.children?.map((child) => filterTree(child, search)).filter((child) => isTreeVisible(child, search));

  return {
    ...node,
    children: filteredChildren && filteredChildren.length > 0 ? filteredChildren : node.children,
  };
}

function isTreeVisible(node: DirectoryTreeNode, search: string): boolean {
  if (search === '') return true;
  const matches = node.name.toLowerCase().includes(search.toLowerCase());
  const childrenMatch = node.children?.some((child) => isTreeVisible(child, search));
  return matches || childrenMatch === true;
}
