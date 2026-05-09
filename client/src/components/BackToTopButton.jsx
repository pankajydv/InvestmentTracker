import React, { useEffect, useState } from 'react';
import { ChevronUp } from 'lucide-react';

const SHOW_AFTER_PX = 280;

export default function BackToTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setVisible(window.scrollY > SHOW_AFTER_PX);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  const handleClick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <button
      type="button"
      aria-label="Back to top"
      className={`back-to-top-btn ${visible ? 'show' : ''}`}
      onClick={handleClick}
    >
      <ChevronUp size={20} />
    </button>
  );
}