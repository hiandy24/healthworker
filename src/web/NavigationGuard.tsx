import { useContext, useEffect } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import { confirmAction } from './confirm';
function Guard({ enabled }: { enabled: boolean }) {
  const blocker = useBlocker(enabled);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    // The router registers blocker functions only after commit, so a
    // navigation started in the same task as a state change (e.g. a
    // successful save disabling this guard right before navigate) can still
    // be blocked with a stale registration. When the guard is disabled by
    // the time the blocked state renders, leaving is safe: resume it
    // without prompting.
    if (!enabled) {
      blocker.proceed();
      return;
    }
    let active = true;
    void confirmAction(
      '当前存在未保障本地恢复的输入或结果不明的请求。离开可能丢失唯一副本，确认离开？',
    ).then((leave) => {
      if (active) {
        if (leave) blocker.proceed();
        else blocker.reset();
      }
    });
    return () => {
      active = false;
    };
  }, [blocker, enabled]);
  return null;
}
export function NavigationGuard({ enabled }: { enabled: boolean }) {
  const router = useContext(UNSAFE_DataRouterContext);
  return router ? <Guard enabled={enabled} /> : null;
}
