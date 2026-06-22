/**
 * Web shim for react-native-share.
 * NativeShare.open is a no-op on web — falls back to navigator.share or clipboard.
 */
const NativeShare = {
  open() {
    return Promise.reject(new Error('NativeShare is not supported on web'));
  },
};

export default NativeShare;
