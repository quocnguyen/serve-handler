// Native
const {promisify} = require('util');
const path = require('path');
const {stat, createReadStream, readdir} = require('fs');

// Packages
const url = require('fast-url-parser');
const slasher = require('glob-slasher');
const minimatch = require('minimatch');
const pathToRegExp = require('path-to-regexp');
const mime = require('mime/lite');
const bytes = require('bytes');

// Other
const template = require('./directory');

const getHandlers = methods => Object.assign({
	stat: promisify(stat),
	createReadStream: createReadStream,
	readdir: promisify(readdir)
}, methods);

const sourceMatches = (source, requestPath, allowSegments) => {
	const keys = [];
	const slashed = slasher(source);

	let results = null;

	if (allowSegments) {
		const normalized = slashed.replace('*', '(.*)');
		const expression = pathToRegExp(normalized, keys);

		results = expression.exec(requestPath);
	}

	if (results || minimatch(requestPath, slashed)) {
		return {
			keys,
			results
		};
	}

	return null;
};

const toTarget = (source, destination, previousPath) => {
	const matches = sourceMatches(source, previousPath, true);

	if (!matches) {
		return null;
	}

	const {keys, results} = matches;

	const props = {};
	const {protocol} = url.parse(destination);
	const normalizedDest = protocol ? destination : slasher(destination);
	const toPath = pathToRegExp.compile(normalizedDest);

	for (let index = 0; index < keys.length; index++) {
		const {name} = keys[index];
		props[name] = results[index + 1];
	}

	return toPath(props);
};

const applyRewrites = (requestPath, rewrites = [], repetitive) => {
	// We need to copy the array, since we're going to modify it.
	const rewritesCopy = rewrites.slice();

	// If the method was called again, the path was already rewritten
	// so we need to make sure to return it.
	const fallback = repetitive ? requestPath : null;

	if (rewritesCopy.length === 0) {
		return fallback;
	}

	for (let index = 0; index < rewritesCopy.length; index++) {
		const {source, destination} = rewrites[index];
		const target = toTarget(source, destination, requestPath);

		if (target) {
			// Remove rules that were already applied
			rewritesCopy.splice(index, 1);

			// Check if there are remaining ones to be applied
			return applyRewrites(slasher(target), rewritesCopy, true);
		}
	}

	return fallback;
};

const shouldRedirect = (decodedPath, {redirects = [], trailingSlash}, cleanUrl) => {
	const slashing = typeof trailingSlash === 'boolean';

	if (redirects.length === 0 && !slashing && !cleanUrl) {
		return null;
	}

	const defaultType = 301;
	const matchHTML = /(\.html|\.htm|\/index)$/g;

	let cleanedUrl = false;

	// By stripping the HTML parts from the decoded
	// path *before* handling the trailing slash, we make
	// sure that only *one* redirect occurs if both
	// config options are used.
	if (cleanUrl && matchHTML.test(decodedPath)) {
		decodedPath = decodedPath.replace(matchHTML, '');
		cleanedUrl = true;
	}

	if (slashing) {
		const {ext, name} = path.parse(decodedPath);
		const isTrailed = decodedPath.endsWith('/');
		const isDotfile = name.startsWith('.');

		let target = null;

		if (!trailingSlash && isTrailed) {
			target = decodedPath.slice(0, -1);
		} else if (trailingSlash && !isTrailed && !ext && !isDotfile) {
			target = `${decodedPath}/`;
		}

		if (decodedPath.indexOf('//') > -1) {
			target = decodedPath.replace(/\/+/g, '/');
		}

		if (target) {
			return {
				target,
				statusCode: defaultType
			};
		}
	}

	if (cleanedUrl) {
		return {
			target: decodedPath,
			statusCode: defaultType
		};
	}

	// This is currently the fastest way to
	// iterate over an array
	for (let index = 0; index < redirects.length; index++) {
		const {source, destination, type} = redirects[index];
		const target = toTarget(source, destination, decodedPath);

		if (target) {
			return {
				target,
				statusCode: type || defaultType
			};
		}
	}

	return null;
};

const appendHeaders = (target, source) => {
	for (let index = 0; index < source.length; index++) {
		const {key, value} = source[index];
		target[key] = value;
	}
};

const getHeaders = async (customHeaders = [], relativePath, rewrittenPath, stats) => {
	const related = {};

	if (customHeaders.length > 0) {
		// By iterating over all headers and never stopping, developers
		// can specify multiple header sources in the config that
		// might match a single path.
		for (let index = 0; index < customHeaders.length; index++) {
			const {source, headers} = customHeaders[index];

			if (sourceMatches(source, relativePath)) {
				appendHeaders(related, headers);
			}
		}
	}

	const defaultHeaders = {
		'Content-Type': mime.getType(relativePath) || mime.getType(rewrittenPath),
		'Last-Modified': stats.mtime.toUTCString(),
		'Content-Length': stats.size
	};

	return Object.assign(defaultHeaders, related);
};

const applicable = (decodedPath, configEntry) => {
	if (typeof configEntry === 'boolean') {
		return configEntry;
	}

	if (Array.isArray(configEntry)) {
		for (let index = 0; index < configEntry.length; index++) {
			const source = configEntry[index];

			if (sourceMatches(source, decodedPath)) {
				return true;
			}
		}

		return false;
	}

	return true;
};

const getPossiblePaths = (relativePath, extension) => [
	path.join(relativePath, `index${extension}`),
	relativePath.endsWith('/') ? relativePath.replace(/\/$/g, extension) : (relativePath + extension)
];

const findRelated = async (current, relativePath, rewrittenPath, originalStat, extension = '.html') => {
	const possible = rewrittenPath ? [rewrittenPath] : getPossiblePaths(relativePath, extension);

	let stats = null;

	for (let index = 0; index < possible.length; index++) {
		const related = possible[index];
		const absolutePath = path.join(current, related);

		try {
			stats = await originalStat(absolutePath);
		} catch (err) {
			if (err.code !== 'ENOENT') {
				throw err;
			}
		}

		if (stats) {
			return {
				stats,
				absolutePath
			};
		}
	}

	if (extension === '.htm') {
		return null;
	}

	// At this point, no `.html` files have been found, so we
	// need to check for the existance of `.htm` ones.
	return findRelated(current, relativePath, rewrittenPath, originalStat, '.htm');
};

const canBeListed = (excluded, file) => {
	const slashed = slasher(file);
	let whether = true;

	for (let mark = 0; mark < excluded.length; mark++) {
		const source = excluded[mark];

		if (sourceMatches(source, slashed)) {
			whether = false;
			break;
		}
	}

	return whether;
};

const renderDirectory = async (current, acceptsJSON, handlers, config, paths) => {
	const {directoryListing, trailingSlash, unlisted = []} = config;
	const slashSuffix = typeof trailingSlash === 'boolean' ? (trailingSlash ? '/' : '') : '/';
	const {relativePath, absolutePath} = paths;

	const excluded = [
		'.DS_Store',
		'.git',
		...unlisted
	];

	if (!applicable(relativePath, directoryListing)) {
		return null;
	}

	let files = await handlers.readdir(absolutePath);

	for (let index = 0; index < files.length; index++) {
		const file = files[index];

		const filePath = path.resolve(absolutePath, file);
		const details = path.parse(filePath);
		const stats = await handlers.stat(filePath);

		details.relative = path.join(relativePath, details.base);

		if (stats.isDirectory()) {
			details.base += slashSuffix;
			details.relative += slashSuffix;
			details.type = 'directory';
		} else {
			details.ext = details.ext.split('.')[1] || 'txt';
			details.type = 'file';

			details.size = bytes(stats.size, {
				unitSeparator: ' ',
				decimalPlaces: 0
			});
		}

		details.title = details.base;

		if (canBeListed(excluded, file)) {
			files[index] = details;
		} else {
			delete files[index];
		}
	}

	const toRoot = path.relative(current, absolutePath);
	const directory = path.join(path.basename(current), toRoot, slashSuffix);
	const pathParts = directory.split(path.sep).filter(Boolean);

	// Sort to list directories first, then sort alphabetically
	files = files.sort((a, b) => {
		const aIsDir = a.type === 'directory';
		const bIsDir = b.type === 'directory';

		/* istanbul ignore next */
		if (aIsDir && !bIsDir) {
			return -1;
		}

		if ((bIsDir && !aIsDir) || (a.base > b.base)) {
			return 1;
		}

		if (a.base < b.base) {
			return -1;
		}

		/* istanbul ignore next */
		return 0;
	}).filter(Boolean);

	// Add parent directory to the head of the sorted files array
	if (toRoot.length > 0) {
		const directoryPath = [...pathParts].slice(1);
		const relative = path.join('/', ...directoryPath, '..', slashSuffix);

		files.unshift({
			type: 'directory',
			base: '..',
			relative,
			title: relative,
			ext: ''
		});
	}

	const subPaths = [];

	for (let index = 0; index < pathParts.length; index++) {
		const parents = [];
		const isLast = index === (pathParts.length - 1);

		let before = 0;

		while (before <= index) {
			parents.push(pathParts[before]);
			before++;
		}

		parents.shift();

		subPaths.push({
			name: pathParts[index] + (isLast ? slashSuffix : '/'),
			url: index === 0 ? '' : parents.join('/') + slashSuffix
		});
	}

	const spec = {
		files,
		directory,
		paths: subPaths
	};

	return acceptsJSON ? JSON.stringify(spec) : template(spec);
};

module.exports = async (request, response, config = {}, methods = {}) => {
	const cwd = process.cwd();
	const current = config.public ? path.join(cwd, config.public) : cwd;
	const handlers = getHandlers(methods);

	let relativePath = decodeURIComponent(url.parse(request.url).pathname);
	let absolutePath = path.join(current, relativePath);

	const cleanUrl = applicable(relativePath, config.cleanUrls);
	const redirect = shouldRedirect(relativePath, config, cleanUrl);

	if (redirect) {
		response.writeHead(redirect.statusCode, {
			Location: redirect.target
		});

		response.end();
		return;
	}

	let stats = null;

	try {
		stats = await handlers.stat(absolutePath);
	} catch (err) {
		if (err.code !== 'ENOENT') {
			response.statusCode = 500;
			response.end(err.message);

			return;
		}
	}

	const rewrittenPath = applyRewrites(relativePath, config.rewrites);

	if ((!stats || stats.isDirectory()) && (cleanUrl || rewrittenPath)) {
		try {
			const related = await findRelated(current, relativePath, rewrittenPath, handlers.stat);

			if (related) {
				({stats, absolutePath} = related);
			}
		} catch (err) {
			if (err.code !== 'ENOENT') {
				response.statusCode = 500;
				response.end(err.message);

				return;
			}
		}
	}

	let acceptsJSON = null;

	if (request.headers.accept) {
		acceptsJSON = request.headers.accept.includes('application/json');
	}

	if (((stats && stats.isDirectory()) || !stats) && acceptsJSON) {
		response.setHeader('Content-Type', 'application/json');
	}

	if (stats && stats.isDirectory()) {
		let directory = null;

		try {
			directory = await renderDirectory(current, acceptsJSON, handlers, config, {
				relativePath,
				absolutePath
			});
		} catch (err) {
			response.statusCode = 500;
			response.end(err.message);

			return;
		}

		if (directory) {
			response.statusCode = 200;

			// When JSON is accepted, we already set the header before
			if (!response.getHeader('Content-Type')) {
				response.setHeader('Content-Type', 'text/html; charset=utf-8');
			}

			response.end(directory);
			return;
		}

		// The directory listing is disabled, so we want to
		// render a 404 error.
		stats = null;
	}

	if (!stats) {
		response.statusCode = 404;

		if (acceptsJSON) {
			response.end(JSON.stringify({
				error: {
					code: 'not_found',
					message: 'Not Found'
				}
			}));

			return;
		}

		const errorPage = '404.html';
		const errorPageFull = path.join(current, errorPage);

		try {
			stats = await handlers.stat(errorPageFull);
		} catch (err) {
			if (err.code !== 'ENOENT') {
				response.statusCode = 500;
				response.end(err.message);

				return;
			}
		}

		if (!stats) {
			response.end('Not Found');
			return;
		}

		absolutePath = errorPageFull;
		relativePath = errorPage;
	}

	const headers = await getHeaders(config.headers, relativePath, rewrittenPath, stats);
	const stream = await handlers.createReadStream(absolutePath);

	response.writeHead(response.statusCode || 200, headers);
	stream.pipe(response);
};
