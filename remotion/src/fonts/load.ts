import {useEffect, useState} from "react";
import {continueRender, delayRender, staticFile} from "remotion";

export const usePretendardFont = (): void => {
  const [handle] = useState(() => delayRender("Loading PretendardVariable"));

  useEffect(() => {
    let continued = false;
    const finish = (): void => {
      if (!continued) {
        continued = true;
        continueRender(handle);
      }
    };
    const font = new FontFace(
      "PretendardVariable",
      `url(${staticFile("fonts/PretendardVariable.woff2")}) format("woff2-variations")`,
      {style: "normal", weight: "45 920"},
    );
    font
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch((error: unknown) => console.error("Pretendard font load failed", error))
      .finally(finish);
    return finish;
  }, [handle]);
};
