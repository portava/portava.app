"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var orval_1 = require("orval");
var path_1 = require("path");
var root = path_1.default.resolve(__dirname, "..", "..");
var apiClientReactSrc = path_1.default.resolve(root, "lib", "api-client-react", "src");
var apiZodSrc = path_1.default.resolve(root, "lib", "api-zod", "src");
// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
var titleTransformer = function (config) {
    var _a;
    (_a = config.info) !== null && _a !== void 0 ? _a : (config.info = {});
    config.info.title = "Api";
    return config;
};
exports.default = (0, orval_1.defineConfig)({
    "api-client-react": {
        input: {
            target: "./openapi.yaml",
            override: {
                transformer: titleTransformer,
            },
        },
        output: {
            workspace: apiClientReactSrc,
            target: "generated",
            client: "react-query",
            mode: "split",
            baseUrl: "/api",
            clean: true,
            prettier: true,
            override: {
                fetch: {
                    includeHttpResponseReturnType: false,
                },
                mutator: {
                    path: path_1.default.resolve(apiClientReactSrc, "custom-fetch.ts"),
                    name: "customFetch",
                },
            },
        },
    },
    zod: {
        input: {
            target: "./openapi.yaml",
            override: {
                transformer: titleTransformer,
            },
        },
        output: {
            workspace: apiZodSrc,
            client: "zod",
            target: "generated",
            schemas: { path: "generated/types", type: "typescript" },
            mode: "split",
            clean: true,
            prettier: true,
            override: {
                zod: {
                    coerce: {
                        query: ['boolean', 'number', 'string'],
                        param: ['boolean', 'number', 'string'],
                        body: ['bigint', 'date'],
                        response: ['bigint', 'date'],
                    },
                },
                useDates: true,
                useBigInt: true,
            },
        },
    },
});
