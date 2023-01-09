/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const util = require("util");
const webpackOptionsSchemaCheck = require("../schemas/WebpackOptions.check.js");
const webpackOptionsSchema = require("../schemas/WebpackOptions.json");
const Compiler = require("./Compiler");
const MultiCompiler = require("./MultiCompiler");
const WebpackOptionsApply = require("./WebpackOptionsApply");
const {
	applyWebpackOptionsDefaults,
	applyWebpackOptionsBaseDefaults
} = require("./config/defaults");
const { getNormalizedWebpackOptions } = require("./config/normalization");
const NodeEnvironmentPlugin = require("./node/NodeEnvironmentPlugin");
const memoize = require("./util/memoize");

/** @typedef {import("../declarations/WebpackOptions").WebpackOptions} WebpackOptions */
/** @typedef {import("./Compiler").WatchOptions} WatchOptions */
/** @typedef {import("./MultiCompiler").MultiCompilerOptions} MultiCompilerOptions */
/** @typedef {import("./MultiStats")} MultiStats */
/** @typedef {import("./Stats")} Stats */

const getValidateSchema = memoize(() => require("./validateSchema"));

/**
 * @template T
 * @callback Callback
 * @param {Error=} err
 * @param {T=} stats
 * @returns {void}
 */

/**
 * @param {ReadonlyArray<WebpackOptions>} childOptions options array
 * @param {MultiCompilerOptions} options options
 * @returns {MultiCompiler} a multi-compiler
 */
const createMultiCompiler = (childOptions, options) => {
	const compilers = childOptions.map(options => createCompiler(options));
	const compiler = new MultiCompiler(compilers, options);
	for (const childCompiler of compilers) {
		if (childCompiler.options.dependencies) {
			compiler.setDependencies(
				childCompiler,
				childCompiler.options.dependencies
			);
		}
	}
	return compiler;
};

/**
 * @param {WebpackOptions} rawOptions options object
 * @returns {Compiler} a compiler
 */
const createCompiler = rawOptions => {
	// 规范化 用户配置
	const options = getNormalizedWebpackOptions(rawOptions);
	// 合并 默认基本配置 与 用户配置
	applyWebpackOptionsBaseDefaults(options);
	// 基于 tapable 的第三方库的 webpack 打包生命周期声明
	const compiler = new Compiler(options.context, options);
	// 挂载、缓存 fs 模块，开启打包计时，【TODO】watchpack 监控文件改变
	new NodeEnvironmentPlugin({
		infrastructureLogging: options.infrastructureLogging
	}).apply(compiler);
	// 挂载 用户插件
	if (Array.isArray(options.plugins)) {
		for (const plugin of options.plugins) {
			if (typeof plugin === "function") {
				plugin.call(compiler, compiler);
			} else {
				plugin.apply(compiler);
			}
		}
	}
	// 合并默认配置 与 用户配置
	applyWebpackOptionsDefaults(options);
	compiler.hooks.environment.call();
	// 环境配置完成
	compiler.hooks.afterEnvironment.call();
	// 挂载 所有 默认插件
	new WebpackOptionsApply().process(options, compiler);
	compiler.hooks.initialize.call();
	// compiler 的配置全部完成，调用 run 方法进行 打包
	return compiler;
};

/**
 * @callback WebpackFunctionSingle
 * @param {WebpackOptions} options options object
 * @param {Callback<Stats>=} callback callback
 * @returns {Compiler} the compiler object
 */

/**
 * @callback WebpackFunctionMulti
 * @param {ReadonlyArray<WebpackOptions> & MultiCompilerOptions} options options objects
 * @param {Callback<MultiStats>=} callback callback
 * @returns {MultiCompiler} the multi compiler object
 */

const asArray = options =>
	Array.isArray(options) ? Array.from(options) : [options];

// 接收 （配置参数，回调函数）
const webpack = /** @type {WebpackFunctionSingle & WebpackFunctionMulti} */ (
	/**
	 * @param {WebpackOptions | (ReadonlyArray<WebpackOptions> & MultiCompilerOptions)} options options
	 * @param {Callback<Stats> & Callback<MultiStats>=} callback callback
	 * @returns {Compiler | MultiCompiler}
	 */
	(options, callback) => {
		const create = () => {
			// webpackOptionsSchemaCheck 检查配置 【TODO】
			if (!asArray(options).every(webpackOptionsSchemaCheck)) {
				// webpackOptionsSchema ； 返回对应配置错误的校验信息
				getValidateSchema()(webpackOptionsSchema, options);
				util.deprecate(
					() => { },
					"webpack bug: Pre-compiled schema reports error while real schema is happy. This has performance drawbacks.",
					"DEP_WEBPACK_PRE_COMPILED_SCHEMA_INVALID"
				)();
			}
			/** @type {MultiCompiler|Compiler} */
			let compiler;
			let watch = false;
			/** @type {WatchOptions|WatchOptions[]} */
			let watchOptions;
			// 多文件配置运行入口
			if (Array.isArray(options)) {
				/** @type {MultiCompiler} */
				compiler = createMultiCompiler(
					options,
					/** @type {MultiCompilerOptions} */(options)
				);
				watch = options.some(options => options.watch);
				watchOptions = options.map(options => options.watchOptions || {});
			} else {
				// 单文件配置运行入口
				const webpackOptions = /** @type {WebpackOptions} */ (options);
				/** @type {Compiler} */
				compiler = createCompiler(webpackOptions);
				watch = webpackOptions.watch;
				watchOptions = webpackOptions.watchOptions || {};
			}
			return { compiler, watch, watchOptions };
		};
		if (callback) {
			try {
				const { compiler, watch, watchOptions } = create();
				if (watch) {
					compiler.watch(watchOptions, callback);
				} else {
					compiler.run((err, stats) => {
						compiler.close(err2 => {
							callback(err || err2, stats);
						});
					});
				}
				return compiler;
			} catch (err) {
				process.nextTick(() => callback(err));
				return null;
			}
		} else {
			const { compiler, watch } = create();
			if (watch) {
				util.deprecate(
					() => { },
					"A 'callback' argument needs to be provided to the 'webpack(options, callback)' function when the 'watch' option is set. There is no way to handle the 'watch' option without a callback.",
					"DEP_WEBPACK_WATCH_WITHOUT_CALLBACK"
				)();
			}
			return compiler;
		}
	}
);

module.exports = webpack;
