import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

import { appOriginFrom, CREDENTIAL_NAME, sourceToDocsApiRequest } from '../transport';
import type { PublicDocumentSummaryData } from '../types';

/**
 * Every document of the workspace, for the Document resource locator's From List mode.
 *
 * Each result is named `<project> / <document>`. Filtered client-side by `filter` against the
 * document name or the project name, since the Public API's list endpoint takes no search
 * parameter.
 */
export async function searchDocuments(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const { documents } = (await sourceToDocsApiRequest.call(this, 'GET', '/documents')) as {
		documents: PublicDocumentSummaryData[];
	};

	const credentials = await this.getCredentials<{ baseUrl?: string }>(CREDENTIAL_NAME);
	const origin = appOriginFrom(credentials.baseUrl ?? '');
	const needle = (filter ?? '').toLowerCase();

	return {
		results: documents
			.filter(
				(document) =>
					document.name.toLowerCase().includes(needle) ||
					document.project_name.toLowerCase().includes(needle),
			)
			.map((document) => ({
				name: `${document.project_name} / ${document.name}`,
				value: document.id,
				url: `${origin}/documents/show/${document.id}`,
			})),
	};
}
