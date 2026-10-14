import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { sourceToDocsApiRequest } from '../transport';
import type { PublicProjectData } from '../types';
import { currentDocument } from './document';

/** `GET /projects`, for the Project dropdown. */
export async function getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const { projects } = (await sourceToDocsApiRequest.call(this, 'GET', '/projects')) as {
		projects: PublicProjectData[];
	};
	return projects.map((project) => ({ name: project.name, value: project.id }));
}

/**
 * The picked Document's Data Sets, for a Data Sets collection entry.
 *
 * Each option's description lists the Data Set's column names, joined, so a person can see
 * what an Inline Row's keys must spell before they type one.
 */
export async function getDataSets(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const document = await currentDocument(this);
	if (document === undefined) {
		return [];
	}
	return document.data_sets.map((dataSet) => ({
		name: dataSet.name,
		value: dataSet.id,
		description:
			dataSet.columns.length > 0
				? dataSet.columns.map((column) => column.name).join(', ')
				: 'This data set has no columns yet',
	}));
}

/**
 * The picked Document's enabled Distributions, for Deliver To.
 *
 * A split-configured Document delivers through its own Distributions, not the node's: this
 * returns one disabled, explanatory option instead of a pickable list.
 */
export async function getDistributions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const document = await currentDocument(this);
	if (document === undefined) {
		return [];
	}
	if (document.split?.enabled === true) {
		return [
			{
				name: 'Not Available — This Document Is Split-Configured and Delivers Through Its Own Distributions',
				value: '',
				disabled: true,
			},
		];
	}
	return document.distributions
		.filter((distribution) => distribution.is_enabled)
		.map((distribution) => ({ name: distribution.label, value: distribution.id }));
}
