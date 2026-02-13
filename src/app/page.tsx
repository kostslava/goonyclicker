'use client';

import { useEffect } from 'react';

export default function Home() {
  useEffect(() => {
    window.location.href = '/fappybird.html';
  }, []);
  
  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-white">
      <p className="text-2xl">Redirecting to Fappy Bird...</p>
    </div>
  );
}
