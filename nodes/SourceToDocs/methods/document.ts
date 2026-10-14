import type { ILoadOptionsFunctions } from 'n8n-workflow';

import { idForPath } from '../ids';
import { sourceToDocsApiRequest } from '../transport';
import type { PublicDocumentData } from '../types';

/** The Document id the currently edited node parameters carry, or `''` when none is picked yet. */
function currentDocumentId(context: ILoadOptionsFunctions): string {
	return (context.getNodeParameter('documentId', '', { extractValue: true }) as string) ?? '';
}

/** The Document the loaders' dependent fields read from, or `undefined` while none is picked. */
export async function currentDocument(
	context: ILoadOptionsFunctions,
): Promise<PublicDocumentData | undefined> {
	const rawDocumentId = currentDocumentId(context);
	if (rawDocumentId === '') {
		return undefined;
	}
	const documentId = idForPath(context.getNode(), 'Document', rawDocumentId);
	const { document } = (await sourceToDocsApiRequest.call(
		context,
		'GET',
		`/documents/${documentId}`,
	)) as {
		document: PublicDocumentData;
	};
	return document;
}
