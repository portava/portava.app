import React from 'react';
import type * as Native from 'react-native';

/** React Native's test renderer has no UIKit dismissal event. Deliver it only on visible → hidden. */
export function withModalDismissal(actual: typeof Native) {
  function DismissibleModal({ visible, children, onDismiss }: Native.ModalProps) {
    const wasVisible = React.useRef(visible);
    React.useEffect(() => {
      const dismissed = wasVisible.current && !visible;
      wasVisible.current = visible;
      if (dismissed) onDismiss?.();
    }, [visible, onDismiss]);
    return visible ? React.createElement(actual.View, null, children) : null;
  }
  return new Proxy(actual, { get(target, key, receiver) {
    return key === 'Modal' ? DismissibleModal : Reflect.get(target, key, receiver);
  } });
}
