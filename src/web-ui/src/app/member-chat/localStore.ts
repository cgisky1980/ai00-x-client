/**
 * localStore — 私聊本地持久化（IndexedDB）
 *
 * 私聊消息服务端不落库也不暂存（明文完全不留服务器，仅在线实时转发），
 * 历史仅存本机 IndexedDB；未读也走本地计算。
 * 注意：换设备/清缓存/离线期间的消息不可恢复。
 *
 * 存储：
 * - dm_messages: keyPath [channel_id, seq]，含 fp 指纹（WS 回显去重）
 * - dm_meta:     keyPath channel_id，{ lastReadSeq, unread, lastMsgAt }
 */
import type { ChatMessage } from './chatApi';

const DB_NAME = 'ai00x-member-chat';
const DB_VERSION = 1;
const STORE_MESSAGES = 'dm_messages';
const STORE_META = 'dm_meta';

/** 本地私聊消息：seq 本地递增序；fp 指纹；status=pending 表示等待对方送达回执 */
export interface LocalDmMessage extends ChatMessage {
  seq: number;
  fp: string;
  status?: 'pending' | 'sent';
}

export interface LocalDmMeta {
  channel_id: number;
  lastReadSeq: number;
  unread: number;
  lastMsgAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
/** 每频道 seq 内存缓存（避免每次写都读 max） */
const seqCursors = new Map<number, number>();

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          db.createObjectStore(STORE_MESSAGES, { keyPath: ['channel_id', 'seq'] });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'channel_id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 消息指纹：WS 回显对象内容稳定 */
function dmFingerprint(m: ChatMessage): string {
  return `${m.sender_id}|${m.content}|${m.created_at}`;
}

/** 幂等键：带 client_msg_id 的消息按 (sender,id) 去重（补发时 created_at 会变），否则退回 fp */
function dmDedupeKey(m: ChatMessage): string {
  return m.client_msg_id
    ? `c:${m.sender_id}:${m.client_msg_id}`
    : `f:${dmFingerprint(m)}`;
}

/** 追加私聊消息（幂等键去重；返回实际新增条数）
 *  @param status 发送方乐观插入传 'pending'；接收方存对方消息用默认 'sent' */
export async function dmAppendMessages(
  channelId: number,
  msgs: ChatMessage[],
  status: 'pending' | 'sent' = 'sent',
): Promise<number> {
  if (msgs.length === 0) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE_MESSAGES, 'readwrite');
  const store = tx.objectStore(STORE_MESSAGES);
  const range = IDBKeyRange.bound([channelId, -Infinity], [channelId, Infinity]);
  const existing = (await reqToPromise(store.getAll(range))) as LocalDmMessage[];
  const keys = new Set(existing.map((x) => (x.client_msg_id ? `c:${x.sender_id}:${x.client_msg_id}` : `f:${x.fp}`)));
  let seq = existing.length > 0 ? Math.max(...existing.map((x) => x.seq)) : 0;
  if ((seqCursors.get(channelId) ?? 0) < seq) seqCursors.set(channelId, seq);
  let added = 0;
  for (const m of msgs) {
    const key = dmDedupeKey(m);
    if (keys.has(key)) continue;
    seq += 1;
    seqCursors.set(channelId, seq);
    keys.add(key);
    const rec: LocalDmMessage = {
      ...m,
      seq,
      fp: dmFingerprint(m),
      status: m.status ?? status,
    };
    store.put(rec);
    added += 1;
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return added;
}

/** 读私聊本地消息（按 seq 升序，全量）。
 *  仅限内部小数据场景（pending 遍历/标记）使用；UI 展示请用 dmGetMessagesPage 分页读取。 */
export async function dmGetMessages(channelId: number): Promise<LocalDmMessage[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_MESSAGES, 'readonly');
  const range = IDBKeyRange.bound([channelId, -Infinity], [channelId, Infinity]);
  const all = (await reqToPromise(
    tx.objectStore(STORE_MESSAGES).getAll(range),
  )) as LocalDmMessage[];
  all.sort((a, b) => a.seq - b.seq);
  // 同步 seq 游标
  const maxSeq = all.length > 0 ? all[all.length - 1].seq : 0;
  if ((seqCursors.get(channelId) ?? 0) < maxSeq) seqCursors.set(channelId, maxSeq);
  return all;
}

/** 分页读私聊本地消息（keyset 翻页，本地 IndexedDB 也不会全量拉取）。
 *  按 seq 倒序游标取 limit 条，返回升序（旧→新），与服务器 list_messages 语义一致；
 *  beforeSeq 不含（传当前最旧一条的 seq 往前翻页）。 */
export async function dmGetMessagesPage(
  channelId: number,
  opts: { beforeSeq?: number; limit: number },
): Promise<LocalDmMessage[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_MESSAGES, 'readonly');
  const range =
    opts.beforeSeq !== undefined
      ? IDBKeyRange.bound([channelId, -Infinity], [channelId, opts.beforeSeq], false, true)
      : IDBKeyRange.bound([channelId, -Infinity], [channelId, Infinity]);
  const out: LocalDmMessage[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = tx.objectStore(STORE_MESSAGES).openCursor(range, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= opts.limit) {
        resolve();
        return;
      }
      out.push(cur.value as LocalDmMessage);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  out.reverse();
  if (out.length > 0 && (seqCursors.get(channelId) ?? 0) < out[out.length - 1].seq) {
    // 翻更早的页时最后一条不是最新 seq；仅首翻（无 beforeSeq）需要同步游标
    if (opts.beforeSeq === undefined) seqCursors.set(channelId, out[out.length - 1].seq);
  }
  return out;
}

/** 轻量读某频道最大本地 seq（cursor 倒序第一步，不拉全量） */
export async function dmGetMaxSeq(channelId: number): Promise<number> {
  const cached = seqCursors.get(channelId);
  if (cached !== undefined) return cached;
  const db = await openDb();
  const tx = db.transaction(STORE_MESSAGES, 'readonly');
  const range = IDBKeyRange.bound([channelId, -Infinity], [channelId, Infinity]);
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(STORE_MESSAGES).openCursor(range, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      const seq = cur ? (cur.value as LocalDmMessage).seq : 0;
      seqCursors.set(channelId, seq);
      resolve(seq);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 删除某私聊的全部本地消息 */
export async function dmClearMessages(channelId: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_MESSAGES, 'readwrite');
  const range = IDBKeyRange.bound([channelId, -Infinity], [channelId, Infinity]);
  tx.objectStore(STORE_MESSAGES).delete(range);
  seqCursors.delete(channelId);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 读频道本地 meta */
export async function dmGetMeta(channelId: number): Promise<LocalDmMeta | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  return reqToPromise(tx.objectStore(STORE_META).get(channelId)) as Promise<
    LocalDmMeta | undefined
  >;
}

/** 读全部频道 meta（启动时恢复本地未读） */
export async function dmGetAllMeta(): Promise<LocalDmMeta[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  return reqToPromise(tx.objectStore(STORE_META).getAll()) as Promise<LocalDmMeta[]>;
}

/** 写频道 meta（覆盖） */
export async function dmSetMeta(meta: LocalDmMeta): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put(meta);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 标记私聊已读：lastReadSeq=本地最新，unread=0（须在 append 之后调用） */
export async function dmMarkRead(channelId: number): Promise<void> {
  const meta = await dmGetMeta(channelId);
  const lastSeq = await dmGetMaxSeq(channelId);
  await dmSetMeta({
    channel_id: channelId,
    lastReadSeq: Math.max(lastSeq, meta?.lastReadSeq ?? 0),
    unread: 0,
    lastMsgAt: meta?.lastMsgAt ?? 0,
  });
}

/** 私聊未读 +1（非当前频道收到消息时） */
export async function dmBumpUnread(channelId: number): Promise<void> {
  const meta = await dmGetMeta(channelId);
  await dmSetMeta({
    channel_id: channelId,
    lastReadSeq: meta?.lastReadSeq ?? 0,
    unread: (meta?.unread ?? 0) + 1,
    lastMsgAt: Date.now(),
  });
}

/** 列出待送达消息（发送方本机，status=pending） */
export async function dmGetPending(channelId: number): Promise<LocalDmMessage[]> {
  const all = await dmGetMessages(channelId);
  return all.filter((m) => m.status === 'pending' && !!m.client_msg_id);
}

/** 按幂等键标记已送达（收到对方 dm_ack 回执时调用） */
export async function dmMarkSentByClientIds(
  channelId: number,
  clientMsgIds: string[],
): Promise<void> {
  if (clientMsgIds.length === 0) return;
  const ids = new Set(clientMsgIds);
  const db = await openDb();
  const tx = db.transaction(STORE_MESSAGES, 'readwrite');
  const store = tx.objectStore(STORE_MESSAGES);
  const range = IDBKeyRange.bound([channelId, -Infinity], [channelId, Infinity]);
  const all = (await reqToPromise(store.getAll(range))) as LocalDmMessage[];
  for (const m of all) {
    if (m.status === 'pending' && m.client_msg_id && ids.has(m.client_msg_id)) {
      store.put({ ...m, status: 'sent' });
    }
  }
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
