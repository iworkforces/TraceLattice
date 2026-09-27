const mode = process.argv[2];

if (typeof process.send !== 'function') {
	throw new Error('shutdown contract fixture requires an IPC channel');
}

const controls = [];
const controlWaiters = [];
const unhandledRejections = [];
const uncaughtExceptions = [];

process.on('message', (message) => {
	if (typeof message !== 'object' || message === null) return;
	const control = Reflect.get(message, 'control');
	if (typeof control !== 'string') return;
	const parsed = Object.freeze({ ...message, control });
	const waiterIndex = controlWaiters.findIndex((waiter) => waiter.control === control);
	if (waiterIndex < 0) {
		controls.push(parsed);
		return;
	}
	const [waiter] = controlWaiters.splice(waiterIndex, 1);
	waiter.resolve(parsed);
});
process.on('unhandledRejection', (error) => unhandledRejections.push(errorMessage(error)));
process.on('uncaughtException', (error) => uncaughtExceptions.push(errorMessage(error)));

function deferred() {
	return Promise.withResolvers();
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function flattenErrors(error) {
	if (!(error instanceof AggregateError)) return [errorMessage(error)];
	return error.errors.flatMap(flattenErrors);
}

function nextControl(control) {
	const queuedIndex = controls.findIndex((message) => message.control === control);
	if (queuedIndex >= 0) {
		const [queued] = controls.splice(queuedIndex, 1);
		return Promise.resolve(queued);
	}
	const waiter = deferred();
	controlWaiters.push({ control, resolve: waiter.resolve });
	return waiter.promise;
}

function requireControlString(control, key) {
	const value = Reflect.get(control, key);
	if (typeof value !== 'string') throw new TypeError(`${key} must be a string`);
	return value;
}

function send(event) {
	return new Promise((resolve, reject) => {
		process.send(event, (error) => (error ? reject(error) : resolve()));
	});
}

function nextTurn() {
	return new Promise((resolve) => setImmediate(resolve));
}

async function finish(code, event) {
	process.exitCode = code;
	await send(event);
	await nextTurn();
	process.disconnect();
}

function cleanConfig(ServerConfig, dataDir) {
	return new ServerConfig({
		persistence: dataDir
			? { enabled: true, backend: 'file', options: { dataDir } }
			: { enabled: false, backend: 'memory' },
		persistenceBufferSize: 1_000,
		persistenceFlushInterval: 60_000,
		persistenceMaxRetries: 0,
	});
}

async function runDeadline() {
	const { CliLifecycle, createCliShutdownHandler } = await import('../../../dist/CliLifecycle.js');
	const transportGate = deferred();
	const serverStopped = deferred();
	let transportStops = 0;
	let serverStops = 0;
	let reportCount = 0;
	let reportedError;
	const exits = [];
	const lifecycle = new CliLifecycle(
		{
			stop: async () => {
				serverStops++;
				serverStopped.resolve();
			},
		},
		{ deadlineMs: 25 }
	);
	lifecycle.attachTransport({
		stop: async () => {
			transportStops++;
			await transportGate.promise;
		},
	});
	const handler = createCliShutdownHandler(lifecycle, {
		reportFailure: (error) => {
			reportCount++;
			reportedError = error;
			process.stderr.write(
				`${JSON.stringify({ code: error.code, message: error.message, name: error.name, timeoutMs: error.timeoutMs })}\n`
			);
		},
		exit: (code) => {
			exits.push(code);
			process.exitCode = code;
		},
	});
	const first = handler();
	const repeated = handler();
	await first;
	await send({
		event: 'deadline-observed',
		transportStops,
		serverStops,
		samePromise: first === repeated,
		reportCount,
		exits,
		error: {
			name: reportedError.name,
			code: reportedError.code,
			message: reportedError.message,
			timeoutMs: reportedError.timeoutMs,
		},
	});
	await nextControl('release-transport');
	transportGate.resolve();
	await serverStopped.promise;
	await nextTurn();
	await finish(1, {
		event: 'deadline-final',
		transportStops,
		serverStops,
		reportCount,
		exits,
		unhandledRejections,
		uncaughtExceptions,
	});
}

async function runCleanupRejection() {
	const { CliLifecycle, createCliShutdownHandler } = await import('../../../dist/CliLifecycle.js');
	let transportStops = 0;
	let serverStops = 0;
	let reportCount = 0;
	let causes = [];
	const exits = [];
	const lifecycle = new CliLifecycle({
		stop: async () => {
			serverStops++;
			throw new Error('server failure');
		},
	});
	lifecycle.attachTransport({
		stop: async () => {
			transportStops++;
			throw new AggregateError(
				[
					new Error('transport first'),
					new AggregateError([new Error('transport second')], 'nested'),
				],
				'transport'
			);
		},
	});
	const handler = createCliShutdownHandler(lifecycle, {
		reportFailure: (error) => {
			reportCount++;
			causes = flattenErrors(error);
			process.stderr.write(
				`${JSON.stringify({ causes, message: error.message, name: error.name })}\n`
			);
		},
		exit: (code) => {
			exits.push(code);
			process.exitCode = code;
		},
	});
	const first = handler();
	const repeated = handler();
	await first;
	await nextTurn();
	await finish(1, {
		event: 'cleanup-rejection-final',
		transportStops,
		serverStops,
		samePromise: first === repeated,
		reportCount,
		exits,
		causes,
		unhandledRejections,
		uncaughtExceptions,
	});
}

async function createProtocolServer(handler) {
	const [{ ValibotJsonSchemaAdapter }, { McpServer }, schema] = await Promise.all([
		import('@tmcp/adapter-valibot'),
		import('tmcp'),
		import('../../../dist/schema.js'),
	]);
	const server = new McpServer(
		{ name: 'shutdown-contract-fixture', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
	);
	server.tool(
		{
			name: 'sequentialthinking_tools',
			description: schema.SEQUENTIAL_THINKING_TOOL.description,
			schema: schema.SequentialThinkingSchema,
		},
		handler
	);
	return server;
}

function listeningPort(transport) {
	const address = transport._server.address();
	if (address === null || typeof address === 'string') {
		throw new TypeError('fixture transport has no TCP address');
	}
	return address.port;
}

async function runStreamableFile() {
	const configured = await nextControl('configure');
	const dataDir = requireControlString(configured, 'dataDir');
	const [lifecycleModule, libModule, configModule, transportModule, persistenceModule] =
		await Promise.all([
			import('../../../dist/CliLifecycle.js'),
			import('../../../dist/lib.js'),
			import('../../../dist/ServerConfig.js'),
			import('../../../dist/transport/StreamableHttpTransport.js'),
			import('../../../dist/persistence/FilePersistence.js'),
		]);
	const workGate = deferred();
	const persistenceGate = deferred();
	const originalSave = persistenceModule.FilePersistence.prototype.saveThoughtForSession;
	let responseFinishes = 0;
	let shutdownSettled = false;
	const exits = [];
	persistenceModule.FilePersistence.prototype.saveThoughtForSession = async function (
		sessionId,
		thought
	) {
		await send({ event: 'persistence-write-started' });
		await persistenceGate.promise;
		return originalSave.call(this, sessionId, thought);
	};
	try {
		const thinkingServer = await libModule.createServer({
			config: cleanConfig(configModule.ServerConfig, dataDir),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const protocolServer = await createProtocolServer(async (input) => {
			await send({ event: 'work-started' });
			await workGate.promise;
			const result = await thinkingServer.processThought(input);
			await send({ event: 'work-acknowledged' });
			return result;
		});
		const transport = new transportModule.StreamableHttpTransport({
			port: 0,
			host: '127.0.0.1',
			stateful: false,
			requestTimeout: 25,
			enableRateLimit: false,
		});
		await transport.connect(protocolServer);
		transport._server.on('request', (_request, response) => {
			response.once('finish', () => responseFinishes++);
		});
		const lifecycle = new lifecycleModule.CliLifecycle(thinkingServer);
		lifecycle.attachTransport(transport);
		const handler = lifecycleModule.createCliShutdownHandler(lifecycle, {
			reportFailure: (error) => {
				throw error;
			},
			exit: (code) => {
				exits.push(code);
				process.exitCode = code;
			},
		});
		await send({ event: 'streamable-ready', port: listeningPort(transport) });
		await nextControl('begin-shutdown');
		await send({ event: 'shutdown-started' });
		const shutdown = handler().then(() => {
			shutdownSettled = true;
		});
		await nextControl('observe-shutdown');
		await nextTurn();
		if (!shutdownSettled) await send({ event: 'shutdown-pending' });
		await nextControl('release-work');
		workGate.resolve();
		await nextControl('observe-shutdown');
		await nextTurn();
		if (!shutdownSettled) await send({ event: 'shutdown-pending' });
		await nextControl('release-persistence');
		persistenceGate.resolve();
		await shutdown;
		await finish(0, {
			event: 'streamable-final',
			exits,
			responseFinishes,
			unhandledRejections,
			uncaughtExceptions,
		});
	} finally {
		persistenceModule.FilePersistence.prototype.saveThoughtForSession = originalSave;
	}
}

async function runReloadFile() {
	const configured = await nextControl('configure');
	const dataDir = requireControlString(configured, 'dataDir');
	const sessionId = requireControlString(configured, 'sessionId');
	const [{ FilePersistence }, { asSessionId }] = await Promise.all([
		import('../../../dist/persistence/FilePersistence.js'),
		import('../../../dist/contracts/ids.js'),
	]);
	const persistence = await FilePersistence.create({ dataDir });
	const history = await persistence.loadHistoryForSession(asSessionId(sessionId));
	const thoughts = history.map((thought) => ({
		thought: thought.thought,
		thought_number: thought.thought_number,
		total_thoughts: thought.total_thoughts,
		next_thought_needed: thought.next_thought_needed,
		session_id: thought.session_id,
	}));
	await persistence.close();
	await finish(0, { event: 'reload-final', thoughts });
}

async function createRace() {
	const configured = await nextControl('configure');
	const dataDir = requireControlString(configured, 'dataDir');
	const order = requireControlString(configured, 'order');
	const [lifecycleModule, libModule, configModule, transportModule] = await Promise.all([
		import('../../../dist/CliLifecycle.js'),
		import('../../../dist/lib.js'),
		import('../../../dist/ServerConfig.js'),
		import('../../../dist/transport/StreamableHttpTransport.js'),
	]);
	const server = await libModule.createServer({
		config: cleanConfig(configModule.ServerConfig, dataDir),
		autoDiscover: false,
		loadFromPersistence: false,
	});
	const sessionId = 'shutdown-race-session';
	await server.processThought({
		thought: 'durable race seed', thought_number: 1, total_thoughts: 2,
		next_thought_needed: true, session_id: sessionId,
	});
	await server.history._flushBuffer();
	const container = server.getContainer();
	const lifecycle = container.resolve('sessionLifecycle');
	const persistence = container.resolve('Persistence');
	const outcomes = container.resolve('outcomeRecorder');
	outcomes.recordVerification({
		thoughtId: 'race-outcome', sessionId, predicted: 0.8, actual: 1, type: 'verification',
	});
	const workGate = deferred();
	const clearGate = deferred();
	const originalRun = lifecycle.runOperation.bind(lifecycle);
	let gateWork = true;
	lifecycle.runOperation = (candidate, operation) => originalRun(candidate, async () => {
		if (candidate === sessionId && gateWork) {
			gateWork = false;
			await send({ event: 'core-admitted', phase: lifecycle.globalPhase, idle: lifecycle.isIdle(candidate) });
			await workGate.promise;
		}
		return operation();
	});
	const originalClear = persistence.clearAll.bind(persistence);
	persistence.clearAll = async () => {
		await send({ event: 'clear-started' });
		await clearGate.promise;
		if (order === 'clear-failure') throw new Error('controlled clear before mutation');
		await originalClear();
	};
	let responseFinishes = 0;
	const protocolServer = await createProtocolServer(async (input) => {
		const result = await server.processThought(input);
		await send({ event: 'work-acknowledged' });
		return result;
	});
	const transport = new transportModule.StreamableHttpTransport({
		port: 0, host: '127.0.0.1', stateful: false,
		requestTimeout: 25, enableRateLimit: false,
	});
	await transport.connect(protocolServer);
	transport._server.on('request', (_request, response) => {
		response.once('finish', () => responseFinishes++);
	});
	await send({ event: 'race-ready', port: listeningPort(transport) });
	return {
		order, server, sessionId, lifecycle, persistence, outcomes, workGate, clearGate,
		transport, lifecycleModule, responseFinishes: () => responseFinishes,
	};
}

function beginRaceShutdown(race, exits) {
	const owner = new race.lifecycleModule.CliLifecycle({
		stop: async () => {
			await send({ event: 'server-stop-started' });
			await race.server.stop();
		},
	});
	owner.attachTransport({
		stop: async () => {
			await race.transport.stop();
			await send({ event: 'transport-stopped' });
		},
	});
	const handler = race.lifecycleModule.createCliShutdownHandler(owner, {
		reportFailure: (error) => { throw error; },
		exit: (code) => { exits.push(code); process.exitCode = code; },
	});
	return handler();
}

async function runResetFirst(race) {
	await nextControl('begin-claim');
	const reset = race.server.resetAll();
	await send({ event: 'reset-claimed', phase: race.lifecycle.globalPhase });
	await nextControl('attempt-stop');
	const firstStop = race.server.stop();
	const repeatedStop = race.server.stop();
	const error = await firstStop.then(() => null, (failure) => failure);
	await send({
		event: 'stop-rejected', phase: race.lifecycle.globalPhase,
		samePromise: firstStop === repeatedStop, error: error?.name,
	});
	await nextControl('release-work');
	race.workGate.resolve();
	await nextControl('release-clear');
	race.clearGate.resolve();
	await reset;
	const cachedStop = race.server.stop();
	await race.transport.stop();
	await race.server.history.shutdownWithinLifecycle();
	await race.persistence.close();
	await finish(0, {
		event: 'reset-first-final', phase: race.lifecycle.globalPhase,
		liveThoughts: race.server.history.getSessionIds().length,
		outcomes: race.outcomes.getAllOutcomes().length,
		sameStopPromise: cachedStop === firstStop,
		responseFinishes: race.responseFinishes(), unhandledRejections, uncaughtExceptions,
	});
	process.exit(0);
}

async function runShutdownFirst(race) {
	await nextControl('begin-claim');
	const shutdown = race.server.stop();
	await send({ event: 'shutdown-claimed', phase: race.lifecycle.globalPhase });
	await nextControl('attempt-reset');
	const error = await race.server.resetAll().then(() => null, (failure) => failure);
	await send({ event: 'reset-rejected', phase: race.lifecycle.globalPhase, error: error?.name });
	await nextControl('release-work');
	race.workGate.resolve();
	await shutdown;
	await race.transport.stop();
	await finish(0, {
		event: 'shutdown-first-final', phase: race.lifecycle.globalPhase,
		responseFinishes: race.responseFinishes(), unhandledRejections, uncaughtExceptions,
	});
}

async function runClearFailure(race) {
	const exits = [];
	await nextControl('begin-claim');
	const reset = race.server.resetAll().then(() => null, (error) => error);
	await send({ event: 'reset-claimed', phase: race.lifecycle.globalPhase });
	await nextControl('release-work');
	race.workGate.resolve();
	await nextControl('release-clear');
	race.clearGate.resolve();
	const failure = await reset;
	const admission = await race.server.processThought({
		thought: 'must remain blocked', thought_number: 3, total_thoughts: 3,
		next_thought_needed: false, session_id: race.sessionId,
	});
	await send({
		event: 'clear-failed', phase: race.lifecycle.globalPhase,
		error: errorMessage(failure),
		liveThoughts: race.server.history.getHistory(race.sessionId).length,
		outcomes: race.outcomes.getAllOutcomes().length, admissionRejected: admission.isError === true,
	});
	await nextControl('begin-shutdown');
	await beginRaceShutdown(race, exits);
	await finish(0, {
		event: 'clear-failure-final', phase: race.lifecycle.globalPhase, exits,
		responseFinishes: race.responseFinishes(), unhandledRejections, uncaughtExceptions,
	});
}

async function runResetShutdownRace() {
	const race = await createRace();
	switch (race.order) {
		case 'reset-first':
			await runResetFirst(race);
			return;
		case 'shutdown-first':
			await runShutdownFirst(race);
			return;
		case 'clear-failure':
			await runClearFailure(race);
			return;
		default:
			throw new TypeError(`unknown race order: ${race.order}`);
	}
}

async function main() {
	switch (mode) {
		case 'deadline':
			await runDeadline();
			return;
		case 'cleanup-rejection':
			await runCleanupRejection();
			return;
		case 'streamable-file':
			await runStreamableFile();
			return;
		case 'reload-file':
			await runReloadFile();
			return;
		case 'reset-shutdown-race':
			await runResetShutdownRace();
			return;
		default:
			throw new TypeError(`unknown shutdown contract fixture mode: ${String(mode)}`);
	}
}

main().catch(async (error) => {
	process.exitCode = 1;
	process.stderr.write(`${JSON.stringify({ fixtureError: errorMessage(error) })}\n`);
	if (process.connected) {
		await send({ event: 'fixture-failed', error: errorMessage(error) });
		process.disconnect();
	}
});
