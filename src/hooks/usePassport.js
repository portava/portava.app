"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usePassport = usePassport;
/**
 * usePassport — data seam for the Passport screen.
 * Today: returns mock data synchronously. Later: swap the body for a fetch to
 * the backend (auth'd) without changing the screen. Shape is the contract.
 */
var react_1 = require("react");
var passport_1 = require("../data/passport");
function usePassport() {
    var _a = (0, react_1.useState)({
        data: null, loading: true, error: null,
    }), state = _a[0], setState = _a[1];
    (0, react_1.useEffect)(function () {
        // TODO(backend): replace with GET /me/passport. Keep the same PassportData shape.
        var alive = true;
        var id = setTimeout(function () {
            if (alive)
                setState({ data: passport_1.mockPassport, loading: false, error: null });
        }, 0);
        return function () { alive = false; clearTimeout(id); };
    }, []);
    return state;
}
