import { useEffect, useRef } from 'react';
import { useMantineColorScheme } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { settingsQuery } from './lib';

// Hydrate once per mounted application, never reset on errors or background refetch.
export function CloudTheme() {
  const { data } = useQuery(settingsQuery);
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const initial = useRef(colorScheme);
  const applied = useRef(false);
  useEffect(() => {
    if (colorScheme !== initial.current) applied.current = true;
    if (!applied.current && data) {
      applied.current = true;
      setColorScheme(data.data.theme);
    }
  }, [data, colorScheme, setColorScheme]);
  return null;
}
