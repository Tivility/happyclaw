/**
 * Feishu Document API — standalone wrapper for document/folder/permission operations.
 * No framework imports.
 */
import * as lark from '@larksuiteoapi/node-sdk';

// ─── Types ───────────────────────────────────────────────────────

export interface CreateDocumentResult {
  documentId: string;
  url: string;
}

interface BlockChild {
  block_type: number;
  text?: { elements: Array<{ text_run?: { content: string; text_element_style?: Record<string, unknown> } }> };
  heading1?: { elements: Array<{ text_run?: { content: string } }> };
  heading2?: { elements: Array<{ text_run?: { content: string } }> };
  heading3?: { elements: Array<{ text_run?: { content: string } }> };
  divider?: Record<string, never>;
  bullet?: { elements: Array<{ text_run?: { content: string; text_element_style?: Record<string, unknown> } }> };
  ordered?: { elements: Array<{ text_run?: { content: string; text_element_style?: Record<string, unknown> } }> };
  todo?: { elements: Array<{ text_run?: { content: string } }>; style?: { done?: boolean } };
  children?: BlockChild[];
}

// ─── Block Builders ──────────────────────────────────────────────

function textRun(content: string, bold = false) {
  const run: { content: string; text_element_style?: Record<string, unknown> } = { content };
  if (bold) run.text_element_style = { bold: true };
  return { text_run: run };
}

export function heading1Block(text: string): BlockChild { return { block_type: 3, heading1: { elements: [textRun(text)] } }; }
export function heading2Block(text: string): BlockChild { return { block_type: 4, heading2: { elements: [textRun(text)] } }; }
export function heading3Block(text: string): BlockChild { return { block_type: 5, heading3: { elements: [textRun(text)] } }; }
export function textBlock(content: string, bold = false): BlockChild { return { block_type: 2, text: { elements: [textRun(content, bold)] } }; }
export function bulletBlock(content: string, bold = false): BlockChild { return { block_type: 12, bullet: { elements: [textRun(content, bold)] } }; }
export function orderedBlock(content: string): BlockChild { return { block_type: 13, ordered: { elements: [textRun(content)] } }; }
export function todoBlock(content: string, done = false): BlockChild { return { block_type: 17, todo: { elements: [textRun(content)], style: { done } } }; }
export function dividerBlock(): BlockChild { return { block_type: 22, divider: {} }; }

// ─── API Functions ───────────────────────────────────────────────

export async function createFolder(client: lark.Client, name: string, parentToken?: string): Promise<string | null> {
  try {
    const res = await client.drive.v1.file.createFolder({ data: { name, folder_token: parentToken || '' } as any });
    const token = (res as any)?.data?.token || (res as any)?.token;
    if (!token) { console.error('[feishu-doc] createFolder returned no token'); return null; }
    console.log(`[feishu-doc] folder created: ${name} → ${token}`);
    return token;
  } catch (err) {
    console.error('[feishu-doc] createFolder failed:', err);
    return null;
  }
}

export async function createDocument(client: lark.Client, title: string, folderToken?: string): Promise<CreateDocumentResult | null> {
  try {
    const res = await client.docx.v1.document.create({ data: { title, folder_token: folderToken } });
    const doc = (res as any)?.data?.document || (res as any)?.document;
    const documentId = doc?.document_id;
    if (!documentId) { console.error('[feishu-doc] createDocument returned no id'); return null; }
    const url = `https://open.feishu.cn/docx/${documentId}`;
    console.log(`[feishu-doc] document created: ${title} → ${documentId}`);
    return { documentId, url };
  } catch (err) {
    console.error('[feishu-doc] createDocument failed:', err);
    return null;
  }
}

export async function writeDocumentBlocks(client: lark.Client, documentId: string, blocks: BlockChild[]): Promise<boolean> {
  try {
    for (const block of blocks) {
      await client.docx.v1.documentBlockChildren.create({
        path: { document_id: documentId, block_id: documentId },
        data: { children: [block as any] },
      });
    }
    console.log(`[feishu-doc] ${blocks.length} blocks written`);
    return true;
  } catch (err) {
    console.error('[feishu-doc] writeDocumentBlocks failed:', err);
    return false;
  }
}

export async function grantPermission(
  client: lark.Client,
  token: string,
  tokenType: 'doc' | 'docx' | 'folder',
  memberId: string,
  memberType: 'userid' | 'openid' = 'openid',
  perm: 'view' | 'edit' | 'full_access' = 'full_access',
): Promise<boolean> {
  try {
    await client.drive.v1.permissionMember.create({
      path: { token },
      params: { type: tokenType === 'folder' ? 'folder' : 'docx' },
      data: { member_type: memberType, member_id: memberId, perm },
    });
    console.log(`[feishu-doc] permission granted: ${memberId} → ${perm}`);
    return true;
  } catch {
    // May already exist, not fatal
    return false;
  }
}
