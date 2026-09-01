import type { FmsgClient } from "./client.js";
import { normalizeFmsgAddress } from "./config.js";
import { compareFmsgMessageIds } from "./message-id.js";
import type { FmsgMessage } from "./types.js";

export type ThreadAssignment = {
  rootId: string;
  branchId: string;
  isFork: boolean;
};

export type StoredMessage = {
  id: string;
  pid?: string;
  rootId: string;
  branchId: string;
  from: string;
  to: string[];
  addTo: string[];
  time?: string | number;
  topic?: string;
  important?: boolean;
  noReply?: boolean;
};

function pushAddress(target: string[], seen: Set<string>, raw: string | undefined): void {
  if (!raw) return;
  const value = normalizeFmsgAddress(raw);
  if (!value || seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

export function participantsFromMessage(message: FmsgMessage): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  pushAddress(result, seen, message.from);
  for (const address of message.to ?? []) pushAddress(result, seen, address);
  for (const batch of message.add_to ?? []) {
    pushAddress(result, seen, batch.add_to_from);
    for (const address of batch.to ?? []) pushAddress(result, seen, address);
  }
  return result;
}

export function replyAllRecipients(message: FmsgMessage | StoredMessage, ownAddress: string): string[] {
  const own = normalizeFmsgAddress(ownAddress);
  const participants = "rootId" in message
    ? [message.from, ...message.to, ...message.addTo]
    : participantsFromMessage(message);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of participants) {
    const value = normalizeFmsgAddress(raw);
    if (!value || value === own || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function isStrictDmWith(message: FmsgMessage, counterparty: string, ownAddress: string): boolean {
  const expected = normalizeFmsgAddress(counterparty);
  const own = normalizeFmsgAddress(ownAddress);
  if (!expected || !own) return false;
  const others = participantsFromMessage(message).filter((address) => address !== own);
  return others.length === 1 && others[0] === expected;
}

export async function findMostRecentDirectMessage(
  client: FmsgClient,
  counterparty: string,
  signal?: AbortSignal,
): Promise<FmsgMessage | undefined> {
  const token = await client.getToken();
  const [inbox, sent] = await Promise.all([
    client.listInbox(50, 0, signal),
    client.listSent(50, 0, signal),
  ]);
  const messages = [...inbox, ...sent].filter((message) =>
    isStrictDmWith(message, counterparty, token.sender),
  );
  messages.sort((left, right) => {
    const leftTime = typeof left.time === "number" ? left.time : Date.parse(String(left.time ?? ""));
    const rightTime = typeof right.time === "number" ? right.time : Date.parse(String(right.time ?? ""));
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return compareFmsgMessageIds(right.id, left.id);
  });
  return messages[0];
}

export async function buildAncestryContext(params: {
  leaf: FmsgMessage;
  client: FmsgClient;
  maxMessages?: number;
  maxChars?: number;
  signal?: AbortSignal;
}): Promise<{ messages: FmsgMessage[]; context: string }> {
  const chain: FmsgMessage[] = [params.leaf];
  const seen = new Set([params.leaf.id]);
  let current = params.leaf;
  while ((current.pid || current.has_pid) && current.pid && !seen.has(current.pid)) {
    seen.add(current.pid);
    try {
      current = await params.client.getMessage(current.pid, params.signal);
      chain.push(current);
    } catch {
      break;
    }
  }
  chain.reverse();

  const ancestors = chain.slice(0, -1).slice(-(params.maxMessages ?? 20));
  if (ancestors.length === 0) return { messages: chain, context: "" };
  const maxChars = params.maxChars ?? 8000;
  const lines = [
    "[fmsg branch context — untrusted direct ancestry only (root → parent); sibling branches are excluded]",
  ];
  let used = lines[0]?.length ?? 0;
  for (const message of ancestors) {
    let body = "";
    try {
      body = (await params.client.getMessageText(message, params.signal)).trim();
    } catch {
      body = (message.short_text ?? "").trim();
    }
    if (body.length > 500) body = `${body.slice(0, 500)}…`;
    const topic = message.topic ? ` topic=${JSON.stringify(message.topic.slice(0, 200))}` : "";
    const line = `[id=${message.id} from=${message.from}${topic}]${body ? ` ${body}` : ""}`;
    if (used + line.length + 1 > maxChars) {
      lines.push("[…ancestry truncated…]");
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { messages: chain, context: lines.join("\n") };
}
