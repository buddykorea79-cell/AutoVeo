import {useCallback, useEffect, useRef, useState} from "react";

export interface RemoteData<T> {
  readonly data: T | null;
  readonly failed: boolean;
  reload: () => void;
  set: (value: T) => void;
}

/**
 * 화면이 열릴 때와 key 가 바뀔 때 서버에서 한 번 읽어 온다.
 * 응답이 늦게 도착한 요청은 버려서 화면이 옛 값으로 되돌아가지 않게 한다.
 */
export const useRemoteData = <T>(load: (() => Promise<T>) | null, key: string): RemoteData<T> => {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const current = loadRef.current;
    if (current === null) {
      return;
    }
    let active = true;
    current()
      .then((value) => {
        if (active) {
          setData(value);
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [key, nonce]);

  return {
    data,
    failed,
    reload: useCallback(() => setNonce((value) => value + 1), []),
    set: useCallback((value: T) => setData(value), []),
  };
};
