/* /api/* — forwarded to the serverless backend (see ../_backend.js). */
import { forward } from '../_backend.js';

export const onRequest = forward;
