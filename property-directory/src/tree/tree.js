/**
 * The org hierarchy.
 *
 * A management company owns portfolios, portfolios contain properties,
 * properties sometimes contain buildings — but not always, and not in that
 * order. Some companies have regions between portfolio and property; some
 * properties are independently owned with no parent at all; a property changes
 * management companies and has to move without losing its contact history.
 *
 * So this is a generic tree of one node type rather than four fixed levels. The
 * `kind` field says what a node is; the tree does not care.
 *
 * Two mechanics make it fast and safe:
 *
 *   - **Materialized path.** Every node stores its ancestor ids, root first.
 *     "Everything under this management company" is then a filter, not a
 *     recursive walk, which matters once there are thousands of properties.
 *   - **Cycle prevention on move.** Making a node its own ancestor produces a
 *     tree that infinite-loops on the next traversal. Every move is checked.
 */

/**
 * @param {{kind?: import('../core/types.js').NodeKind, name: string, parentId?: string|null,
 *          address?: object, attrs?: object, source?: object, id?: string}} init
 * @returns {import('../core/types.js').OrgNode}
 */
export function createNode(init) {
  if (!init?.name?.trim()) throw new Error('a node needs a name');
  const now = new Date().toISOString();
  return {
    id: init.id ?? `n_${randomId()}`,
    kind: init.kind ?? 'property',
    name: init.name.trim(),
    parentId: init.parentId ?? null,
    path: [],
    depth: 0,
    address: init.address,
    attrs: init.attrs ?? {},
    sources: init.source ? [init.source] : [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A tree over a plain Map of nodes. The store owns persistence; this owns the
 * invariants.
 * @param {Map<string, import('../core/types.js').OrgNode>} nodes
 */
export function createTree(nodes = new Map()) {
  function get(id) {
    return nodes.get(id) ?? null;
  }

  /** @param {import('../core/types.js').OrgNode} node */
  function insert(node) {
    if (nodes.has(node.id)) throw new Error(`node ${node.id} already exists`);
    if (node.parentId && !nodes.has(node.parentId)) {
      throw new Error(`parent ${node.parentId} does not exist — insert it first`);
    }
    nodes.set(node.id, node);
    recomputePath(node);
    return node;
  }

  /** @param {import('../core/types.js').OrgNode} node */
  function recomputePath(node) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    node.path = parent ? [...parent.path, parent.id] : [];
    node.depth = node.path.length;
    node.updatedAt = new Date().toISOString();
    return node;
  }

  /**
   * Move a node (and everything beneath it) to a new parent.
   *
   * Properties change management companies. When that happens the whole subtree
   * moves, its paths rewrite, and its contact history stays attached — which is
   * the entire reason assignments live on their own record.
   *
   * @param {string} id
   * @param {string|null} newParentId
   */
  function move(id, newParentId) {
    const node = nodes.get(id);
    if (!node) throw new Error(`node ${id} not found`);

    if (newParentId) {
      const parent = nodes.get(newParentId);
      if (!parent) throw new Error(`parent ${newParentId} not found`);
      if (newParentId === id) throw new Error('a node cannot be its own parent');
      // The new parent must not be inside the subtree being moved.
      if (parent.path.includes(id)) {
        throw new Error(`moving ${id} under ${newParentId} would create a cycle`);
      }
    }

    node.parentId = newParentId ?? null;
    recomputePath(node);

    // Rewrite the subtree. Ordered by depth so each node's parent is already
    // correct by the time it is recomputed.
    for (const child of descendants(id).sort((a, b) => a.depth - b.depth)) {
      recomputePath(child);
    }
    return node;
  }

  /** @param {string} id */
  function children(id) {
    return [...nodes.values()].filter((n) => n.parentId === id);
  }

  /** Everything beneath a node, at any depth. */
  function descendants(id) {
    return [...nodes.values()].filter((n) => n.path.includes(id));
  }

  /** The chain from root down to (but not including) the node. */
  function ancestors(id) {
    const node = nodes.get(id);
    if (!node) return [];
    return node.path.map((pid) => nodes.get(pid)).filter(Boolean);
  }

  /** The node plus everything beneath it. */
  function subtree(id) {
    const node = nodes.get(id);
    return node ? [node, ...descendants(id)] : [];
  }

  /** Roots, or every node of a kind. */
  function roots() {
    return [...nodes.values()].filter((n) => !n.parentId);
  }
  function ofKind(kind) {
    return [...nodes.values()].filter((n) => n.kind === kind);
  }

  /**
   * A readable location string: "The Maple — Uptown Portfolio — Alder Residential".
   * @param {string} id
   */
  function describe(id) {
    const node = nodes.get(id);
    if (!node) return '';
    return [node.name, ...ancestors(id).reverse().map((a) => a.name)].join(' — ');
  }

  /**
   * Fold one node into another — the same duplicate problem the lead ingestor
   * has, with the same answer: keep the record, mark it merged, and leave a
   * pointer so old references still resolve.
   * @param {string} fromId
   * @param {string} intoId
   */
  function merge(fromId, intoId) {
    const from = nodes.get(fromId);
    const into = nodes.get(intoId);
    if (!from || !into) throw new Error('both nodes must exist to merge');
    if (fromId === intoId) throw new Error('cannot merge a node into itself');
    if (into.path.includes(fromId)) throw new Error('cannot merge a node into its own descendant');

    for (const child of children(fromId)) move(child.id, intoId);
    into.attrs = { ...from.attrs, ...into.attrs };
    into.address ??= from.address;
    into.sources = [...into.sources, ...from.sources];
    into.updatedAt = new Date().toISOString();

    from.status = 'merged';
    from.mergedInto = intoId;
    from.updatedAt = into.updatedAt;
    return into;
  }

  /** Resolve through merges so a stale id still lands on the live record. */
  function resolve(id, seen = new Set()) {
    const node = nodes.get(id);
    if (!node) return null;
    if (node.status !== 'merged' || !node.mergedInto) return node;
    if (seen.has(id)) return node; // defensive: a merge loop should never happen
    seen.add(id);
    return resolve(node.mergedInto, seen);
  }

  /**
   * Render the tree as indented text. Used by the CLI and, later, by whatever
   * the portal draws.
   * @param {string} [fromId]
   */
  function render(fromId = null, depth = 0) {
    const list = fromId ? children(fromId) : roots();
    return list
      .filter((n) => n.status !== 'merged')
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((n) => [
        `${'  '.repeat(depth)}${depth ? '└ ' : ''}${n.name}  [${n.kind}]`,
        render(n.id, depth + 1),
      ])
      .filter(Boolean)
      .join('\n');
  }

  return {
    nodes,
    get,
    insert,
    move,
    merge,
    resolve,
    children,
    descendants,
    ancestors,
    subtree,
    roots,
    ofKind,
    describe,
    render,
    size: () => nodes.size,
    all: () => [...nodes.values()],
  };
}

/**
 * The key used to decide whether an incoming record is a property already in
 * the directory.
 *
 * Name alone is not enough — "The Maple" exists in a dozen cities, and a single
 * management company can have two properties with the same name in different
 * submarkets. Name plus city plus the street number is specific enough to be
 * safe and loose enough to survive the formatting differences between a CRM
 * export and a crawler.
 *
 * @param {{name: string, address?: import('../core/types.js').Address}} record
 */
export function naturalKey(record) {
  const name = String(record.name ?? '')
    .toLowerCase()
    .replace(/\b(the|at|apartments?|apts?|residences|lofts|flats|homes|living)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  const city = String(record.address?.city ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const streetNumber = String(record.address?.line1 ?? '').match(/^\d+/)?.[0] ?? '';
  return [name, city, streetNumber].filter(Boolean).join('|');
}

function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
