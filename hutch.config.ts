// @hutch cli=0.27.1 cottontail=0.7.1
export default {
	scripts: {
		engine: ["bun", "scripts/build-engine.ts"],
		dev: "bun scripts/build-engine.ts && hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev",
		build: "bun scripts/build-engine.ts && hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=stable",
	},
	electrobun: {
		version: "2.0.2",
	},
};
