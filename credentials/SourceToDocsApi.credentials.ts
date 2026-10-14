import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class SourceToDocsApi implements ICredentialType {
	name = 'sourceToDocsApi';

	displayName = 'SourceToDocs API';

	icon: Icon = {
		light: 'file:../nodes/SourceToDocs/sourcetodocs.svg',
		dark: 'file:../nodes/SourceToDocs/sourcetodocs.dark.svg',
	};

	// Only this node may use the credential: without these two fields the HTTP Request node and its
	// tool variants can use any credential type, and its generic `authenticate` would add the
	// Bearer token to a request aimed anywhere. n8n adds the AI tool variant by itself.
	supportedNodes = ['sourceToDocs'];

	restrictToSupportedNodes = true as const;

	documentationUrl =
		'https://github.com/2vmodules/n8n-nodes-sourcetodocs?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'A workspace API Token from the API Tokens page in SourceToDocs. It starts with wsk_ and is shown once, when it is created.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.sourcetodocs.com/api/public/v1',
			required: true,
			description:
				'The root of the SourceToDocs Public API. Keep the default. It must start with https://. Test and every request send the API Token to this address, so only enter a host you trust.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiToken}}',
			},
		},
	};

	// n8n reports a failure with the matching rule's message, never with the API's own
	// `message`: a credential test only has the deprecated `request` helper, which the
	// verification scanner rejects, so the messages below are written by hand.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ ($credentials.baseUrl || "").replace(/\\/+$/, "") }}',
			url: '/projects',
			method: 'GET',
		},
		// n8n's types allow one kind of rule per list, but its tester reads each rule by its own `type`:
		// the response-code rules on an error answer, the body rule on a success.
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						"SourceToDocs rejected the 'API Token'. Paste a token from the API Tokens page whole, including its wsk_ prefix; an expired or revoked token is rejected too.",
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message:
						"Nothing answers at 'Base URL' + /projects. 'Base URL' must be the root of the Public API, https://app.sourcetodocs.com/api/public/v1 for the production app.",
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 429,
					message:
						"The Public API allows 60 requests a minute per 'API Token', and it also refuses an 'API Token' that was sent wrongly too many times from one address. Check the token, wait a minute, then test again.",
				},
			},
			{
				// n8n fails a `responseSuccessBody` rule when the body's `key` EQUALS `value`. An
				// `undefined` value matches a body with no `success` at all: the app's HTML page
				// (Base URL set to the app root answers 200), which Test would otherwise pass.
				type: 'responseSuccessBody',
				properties: {
					key: 'success',
					value: undefined,
					message:
						"The answer is not the SourceToDocs Public API. 'Base URL' must be the root of the Public API, https://app.sourcetodocs.com/api/public/v1 for the production app, and not the application itself.",
				},
			},
		] as unknown as NonNullable<ICredentialTestRequest['rules']>,
	};
}
