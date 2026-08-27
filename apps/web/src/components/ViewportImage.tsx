import {useState} from "react";

interface ViewportImageProps {
  readonly alt: string;
  readonly className?: string;
  readonly src: string | null;
}

/**
 * 브라우저의 네이티브 지연 로딩을 쓴다.
 * IntersectionObserver 로 직접 관찰하면 화면이 합성되지 않는 환경에서 영영 로드되지 않는다.
 */
export const ViewportImage = ({alt, className, src}: ViewportImageProps) => {
  const [failed, setFailed] = useState(false);

  return (
    <div className={`viewport-image ${className ?? ""}`}>
      {src === null || failed ? (
        <span aria-hidden="true" className="image-placeholder">
          ◫
        </span>
      ) : (
        <img alt={alt} decoding="async" loading="lazy" onError={() => setFailed(true)} src={src} />
      )}
    </div>
  );
};
