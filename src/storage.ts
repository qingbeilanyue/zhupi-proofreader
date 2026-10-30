import type { ProjectData, ProjectMeta, ProofMark } from './model';

const DB_NAME = 'zhupi-proofreader';
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('meta', { keyPath: 'id' });
      db.createObjectStore('content', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProject(data: ProjectData): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'content'], 'readwrite');
      tx.objectStore('meta').put(data.meta);
      tx.objectStore('content').put({ id: data.meta.id, pdf: data.pdf, marks: data.marks });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadProject(id: string): Promise<ProjectData | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'content'], 'readonly');
      const metaRequest = tx.objectStore('meta').get(id);
      const contentRequest = tx.objectStore('content').get(id);
      tx.oncomplete = () => {
        const meta = metaRequest.result as ProjectMeta | undefined;
        const content = contentRequest.result as { pdf: Blob; marks: ProofMark[] } | undefined;
        resolve(meta && content ? { meta, ...content } : null);
      };
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').getAll();
      request.onsuccess = () => resolve((request.result as ProjectMeta[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
