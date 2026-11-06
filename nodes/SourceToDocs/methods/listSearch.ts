import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

import { appOriginFrom, CREDENTIAL_NAME, sourceToDocsApiRequest } from '../transport';
import type { PublicDocumentSummaryData } from '../types';
import { projectLabels } from './projectLabels';

/**
 * Every document of the workspace, for the Document resource locator's From List mode.
 *
 * Each result is named `<project> / <document>`; a project whose name another project shares
 * shows the start of its id after the name. Options → Project, when set, keeps one project's
 * documents. `filter` matches the whole label, case-insensitively, client-side, since the
 * Public API's list endpoint takes no search parameter.
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

	const chosen: unknown = this.getNodeParameter('options.projectId', '');
	const projectId = typeof chosen === 'string' ? chosen : '';

	const labels = projectLabels(
		documents.map((document) => ({ id: document.project_id, name: document.project_name })),
	);

	return {
		results: documents
			.filter((document) => projectId === '' || document.project_id === projectId)
			.map((document) => ({
				name: `${labels.get(document.project_id) ?? document.project_name} / ${document.name}`,
				value: document.id,
				url: `${origin}/documents/show/${document.id}`,
			}))
			.filter((result) => result.name.toLowerCase().includes(needle)),
	};
}
