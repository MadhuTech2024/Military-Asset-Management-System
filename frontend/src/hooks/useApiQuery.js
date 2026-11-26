import { useCallback, useEffect, useMemo, useState } from "react";
import api, { apiErrorMessage } from "../services/api.js";

export default function useApiQuery(url, params = {}) {
  const paramsKey = JSON.stringify(params);
  const stableParams = useMemo(() => JSON.parse(paramsKey), [paramsKey]);
  const [state, setState] = useState({
    requestKey: null,
    data: null,
    error: "",
    loading: true,
    meta: null,
  });
  const [revision, setRevision] = useState(0);
  const requestKey = JSON.stringify([url, paramsKey, revision]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setState({
      requestKey,
      data: null,
      error: "",
      loading: true,
      meta: null,
    });
    api.get(url, { params: stableParams })
      .then(({ data }) => {
        if (active) {
          setState({
            requestKey,
            data: data.data,
            error: "",
            loading: false,
            meta: data.meta ?? null,
          });
        }
      })
      .catch((error) => {
        if (active) {
          setState({
            requestKey,
            data: null,
            error: apiErrorMessage(error),
            loading: false,
            meta: null,
          });
        }
      });

    return () => {
      active = false;
    };
  }, [url, stableParams, revision, requestKey]);

  const isCurrent = state.requestKey === requestKey;
  return {
    ...state,
    data: isCurrent ? state.data : null,
    error: isCurrent ? state.error : "",
    loading: !isCurrent || state.loading,
    meta: isCurrent ? state.meta : null,
    isCurrent,
    refresh,
  };
}
