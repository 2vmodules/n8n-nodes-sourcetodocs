/** How many characters of a project's id tell two projects of the same name apart. */
const ID_SUFFIX_LENGTH = 4;

/**
 * The name to show for each project: its own name, or `<name> · <first 4 characters of its id>`
 * when two or more of the given projects share that name. Keyed by project id.
 */
export function projectLabels(projects: Array<{ id: string; name: string }>): Map<string, string> {
	const idsByName = new Map<string, Set<string>>();
	for (const { id, name } of projects) {
		const ids = idsByName.get(name) ?? new Set<string>();
		ids.add(id);
		idsByName.set(name, ids);
	}
	const labels = new Map<string, string>();
	for (const { id, name } of projects) {
		const duplicated = (idsByName.get(name)?.size ?? 0) > 1;
		labels.set(id, duplicated ? `${name} · ${id.slice(0, ID_SUFFIX_LENGTH)}` : name);
	}
	return labels;
}
