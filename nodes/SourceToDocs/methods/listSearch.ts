import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

import { idForPath } from '../ids';
import { appOriginFrom, CREDENTIAL_NAME, sourceToDocsApiRequest } from '../transport';
import type { PublicDocumentSummaryData } from '../types';

/**
 * The picked Project's documents, for the Document resource locator's From List mode.
 *
 * Filtered client-side by `filter` against the name, since the Public API's list endpoint
 * takes no search parameter. Returns nothing until a Project is picked — the list has no
 * other way to scope itself.
 */
export async function searchDocuments(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const rawProjectId = (this.getNodeParameter('projectId', '') as string) ?? '';
	if (rawProjectId === '') {
		return { results: [] };
	}
	const projectId = idForPath(this.getNode(), 'Project', rawProjectId);

	const { documents } = (await sourceToDocsApiRequest.call(
		this,
		'GET',
		`/projects/${projectId}/documents`,
	)) as { documents: PublicDocumentSummaryData[] };

	const credentials = await this.getCredentials<{ baseUrl?: string }>(CREDENTIAL_NAME);
	const origin = appOriginFrom(credentials.baseUrl ?? '');
	const needle = (filter ?? '').toLowerCase();

	return {
		results: documents
			.filter((document) => document.name.toLowerCase().includes(needle))
			.map((document) => ({
				name: document.name,
				value: document.id,
				url: `${origin}/documents/show/${document.id}`,
			})),
	};
}
