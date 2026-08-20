/**
 * Directory storage.
 *
 * Same interface shape as the other modules: an in-memory implementation for
 * tests, a file implementation for a single machine, and a swap point for the
 * database the portal will bring.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function createMemoryState() {
  return { nodes: new Map(), contacts: new Map(), assignments: new Map() };
}

/**
 * @param {{path: string}} config
 */
export function createFileStore({ path }) {
  const state = createMemoryState();

  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      for (const node of data.nodes ?? []) state.nodes.set(node.id, node);
      for (const contact of data.contacts ?? []) state.contacts.set(contact.id, contact);
      for (const assignment of data.assignments ?? []) state.assignments.set(assignment.id, assignment);
    } catch {
      try {
        writeFileSync(`${path}.corrupt-${Date.now()}`, readFileSync(path));
      } catch { /* best effort */ }
    }
  }

  return {
    state,
    path,
    save() {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          {
            nodes: [...state.nodes.values()],
            contacts: [...state.contacts.values()],
            assignments: [...state.assignments.values()],
            savedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      return path;
    },
  };
}
