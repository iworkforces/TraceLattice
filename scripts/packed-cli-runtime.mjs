import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PackedCliError } from './packed-cli-cleanup.mjs';

const OPERATION_TIMEOUT_MS = 10_000;
const FORCE_CLOSE_MS = 5_000;
const PACKED_SESSION_ID = 'packed-cli-verification';
const STAGE = { packSucceeded: true, installSucceeded: true };

function runtimeError(code, message) {
	return new PackedCliError(code, message, STAGE);
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deadline(promise, timeoutMs, operation) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(
			() => reject(runtimeError('PACKED_RUNTIME_TIMEOUT', `${operation} timed out`)),
			timeoutMs
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function captureProcess(binaryPath, args, cwd) {
	const child = spawn(binaryPath, args, {
		cwd,
		env: {
			...process.env,
			TRACELATTICE_PRETTY_LOG: 'false',
			TRACELATTICE_TRANSPORT_TYPE: 'stdio',
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
	child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
	const closed = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code, signal) => resolve({ code, signal }));
	});
	return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

async function terminate(running) {
	if (running.child.exitCode !== null || running.child.signalCode !== null) return running.closed;
	running.child.kill('SIGTERM');
	try {
		return await deadline(running.closed, OPERATION_TIMEOUT_MS, 'SIGTERM close');
	} catch (error) {
		if (!(error instanceof PackedCliError)) throw error;
		running.child.kill('SIGKILL');
		return deadline(running.closed, FORCE_CLOSE_MS, 'SIGKILL close');
	}
}

async function verifyVersion(artifact) {
	const running = captureProcess(artifact.binaryPath, ['--version'], artifact.consumerRoot);
	try {
		const status = await deadline(running.closed, OPERATION_TIMEOUT_MS, 'version command');
		if (status.code !== 0 || status.signal !== null) {
			throw runtimeError(
				'PACKED_VERSION_COMMAND_FAILED',
				`version command exited ${status.code ?? status.signal}: ${running.stderr().trim()}`
			);
		}
		const expected = `tracelattice v${artifact.version}\n`;
		if (running.stdout() !== expected) {
			throw runtimeError('PACKED_VERSION_OUTPUT_INVALID', `expected ${JSON.stringify(expected)}`);
		}
		return { command: artifact.binaryPath, output: expected.trim(), exitCode: 0 };
	} finally {
		await terminate(running);
	}
}

class ProtocolClient {
	constructor(running) {
		this.running = running;
		this.pending = new Map();
		this.failure = null;
		this.lines = createInterface({ input: running.child.stdout });
		this.lines.on('line', (line) => this.receive(line));
		this.running.child.stdin.on('error', (error) => {
			this.rejectAll(`stdio CLI stdin failed: ${error}`);
		});
		this.running.closed.then(
			() => {
				if (this.pending.size > 0) {
					this.rejectAll(
						`stdio CLI closed with outstanding requests: ${this.running.stderr().trim()}`
					);
				}
			},
			(error) => this.rejectAll(`stdio CLI process failed: ${error}`)
		);
	}

	receive(line) {
		if (line.trim() === '') return;
		let response;
		try {
			response = JSON.parse(line);
		} catch (error) {
			this.rejectAll(`non-JSON stdout: ${line} (${error})`);
			return;
		}
		if (!isRecord(response) || !Object.hasOwn(response, 'id')) return;
		const key = JSON.stringify(response.id);
		const waiter = this.pending.get(key);
		if (!waiter) {
			this.rejectAll(`unexpected response id: ${key}`);
			return;
		}
		this.pending.delete(key);
		waiter.resolve(response);
	}

	rejectAll(message) {
		this.failure = runtimeError('PACKED_PROTOCOL_INVALID', message);
		for (const waiter of this.pending.values()) {
			waiter.reject(this.failure);
		}
		this.pending.clear();
	}

	request(request) {
		const key = JSON.stringify(request.id);
		if (this.pending.has(key)) {
			throw runtimeError('PACKED_PROTOCOL_INVALID', `duplicate request id: ${key}`);
		}
		const waiter = Promise.withResolvers();
		this.pending.set(key, waiter);
		this.running.child.stdin.write(`${JSON.stringify(request)}\n`);
		return deadline(waiter.promise, OPERATION_TIMEOUT_MS, `${request.method} response`).finally(
			() => {
				this.pending.delete(key);
			}
		);
	}

	notify(notification) {
		this.running.child.stdin.write(`${JSON.stringify(notification)}\n`);
	}

	close() {
		this.lines.close();
	}
}

function requireResult(response, id) {
	if (!isRecord(response) || response.id !== id || !isRecord(response.result)) {
		throw runtimeError('PACKED_PROTOCOL_INVALID', `invalid response for ${String(id)}`);
	}
	return response.result;
}

function callThought(client, id, arguments_) {
	return client.request({
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name: 'sequentialthinking_tools', arguments: arguments_ },
	});
}

async function initializeProtocol(client) {
	const initialized = requireResult(
		await client.request({
			jsonrpc: '2.0',
			id: 'verify-initialize',
			method: 'initialize',
			params: {
				protocolVersion: '2025-03-26',
				capabilities: {},
				clientInfo: { name: 'packed-artifact-verifier', version: '1.0.0' },
			},
		}),
		'verify-initialize'
	);
	if (typeof initialized.protocolVersion !== 'string') {
		throw runtimeError('PACKED_PROTOCOL_INVALID', 'initialize result omitted protocolVersion');
	}
	if (!isRecord(initialized.serverInfo) || initialized.serverInfo.name !== 'tracelattice') {
		throw runtimeError('PACKED_PROTOCOL_INVALID', 'serverInfo.name must be tracelattice');
	}
	client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
	const listed = requireResult(
		await client.request({
			jsonrpc: '2.0',
			id: 'verify-tools',
			method: 'tools/list',
			params: {},
		}),
		'verify-tools'
	);
	if (
		!Array.isArray(listed.tools) ||
		!listed.tools.some((tool) => isRecord(tool) && tool.name === 'sequentialthinking_tools')
	) {
		throw runtimeError('PACKED_PROTOCOL_INVALID', 'sequentialthinking_tools was not listed');
	}
}

async function verifyThoughtSessions(client) {
	const thoughtArguments = {
		thought: 'Verify the installed packed CLI',
		thought_number: 1,
		total_thoughts: 1,
		next_thought_needed: false,
	};
	const valid = requireResult(
		await callThought(client, 'verify-valid-call', {
			...thoughtArguments,
			session_id: PACKED_SESSION_ID,
		}),
		'verify-valid-call'
	);
	if (valid.isError === true || !Array.isArray(valid.content)) {
		throw runtimeError('PACKED_PROTOCOL_INVALID', 'named session call failed');
	}
	const validText = valid.content.find(
		(content) => isRecord(content) && content.type === 'text' && typeof content.text === 'string'
	)?.text;
	let validPayload;
	try {
		validPayload = JSON.parse(validText);
	} catch (error) {
		throw runtimeError(
			'PACKED_PROTOCOL_INVALID',
			`valid tool call returned invalid JSON: ${String(error)}`
		);
	}
	if (!isRecord(validPayload) || validPayload.session_id !== PACKED_SESSION_ID) {
		throw runtimeError('PACKED_PROTOCOL_INVALID', 'named session was not echoed');
	}
	const omitted = requireResult(
		await callThought(client, 'verify-omitted-session', thoughtArguments),
		'verify-omitted-session'
	);
	if (omitted.isError !== true) {
		throw runtimeError('PACKED_PROTOCOL_INVALID', 'omitted thought session was accepted');
	}
	const retired = requireResult(
		await callThought(client, 'verify-retired-session', {
			...thoughtArguments,
			session_id: '__global__',
		}),
		'verify-retired-session'
	);
	if (retired.isError !== true) {
		throw runtimeError('PACKED_PROTOCOL_INVALID', 'retired thought session was accepted');
	}
}

async function exerciseProtocol(artifact) {
	const running = captureProcess(artifact.binaryPath, [], artifact.consumerRoot);
	const client = new ProtocolClient(running);
	try {
		await initializeProtocol(client);
		await verifyThoughtSessions(client);
		running.child.stdin.end();
		const status = await deadline(running.closed, OPERATION_TIMEOUT_MS, 'graceful stdio close');
		if (client.failure) throw client.failure;
		if (status.code !== 0 || status.signal !== null || client.pending.size !== 0) {
			throw runtimeError('PACKED_SHUTDOWN_INVALID', 'stdio CLI did not close cleanly');
		}
		return {
			protocol: {
				initialize: true,
				toolsList: true,
				validNamedSession: true,
				omittedSessionRejected: true,
				retiredSessionRejected: true,
			},
			shutdown: { exitCode: status.code, signal: status.signal, outstandingRequests: 0 },
		};
	} finally {
		client.close();
		await terminate(running);
	}
}

export async function verifyPackedRuntime(artifact) {
	const version = await verifyVersion(artifact);
	const exercised = await exerciseProtocol(artifact);
	return { version, ...exercised };
}
