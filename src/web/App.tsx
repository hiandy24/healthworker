import {
  AppShell,
  Group,
  Text,
  Title,
  Stack,
  Badge,
  NavLink,
  Paper,
  Button,
  Container,
  ThemeIcon,
} from '@mantine/core';
import {
  IconActivity,
  IconLayoutDashboard,
  IconBarbell,
  IconChartLine,
  IconSettings,
} from '@tabler/icons-react';
import {
  Link,
  NavLink as RouterNavLink,
  Routes,
  Route,
} from 'react-router-dom';

import { lazy, Suspense } from 'react';

const WorkoutHistory = lazy(() =>
  import('./Workouts').then((m) => ({ default: m.WorkoutHistory })),
);
const WorkoutDetail = lazy(() =>
  import('./Workouts').then((m) => ({ default: m.WorkoutDetail })),
);
const WorkoutEditorPage = lazy(() =>
  import('./Workouts').then((m) => ({ default: m.WorkoutEditorPage })),
);
const Overview = lazy(() =>
  import('./Stats').then((m) => ({ default: m.Overview })),
);
const Trends = lazy(() =>
  import('./Stats').then((m) => ({ default: m.Trends })),
);

const ExerciseLibrary = lazy(() =>
  import('./Exercises').then((m) => ({ default: m.ExerciseLibrary })),
);

const Settings = lazy(() =>
  import('./Settings').then((m) => ({ default: m.Settings })),
);
const navigation = [
  { path: '/', label: '总览', icon: IconLayoutDashboard },
  { path: '/workouts', label: '训练', icon: IconBarbell },
  { path: '/trends', label: '趋势', icon: IconChartLine },
  { path: '/settings', label: '设置', icon: IconSettings },
];
function Placeholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Stack gap="lg">
      <Title order={1}>{title}</Title>
      <Text c="dimmed">{description}</Text>
      <Paper withBorder p="xl">
        <Stack align="flex-start">
          <Badge variant="light">后续阶段实现</Badge>
          <Title order={2} size="h3">
            此页面不存在
          </Title>
          <Text c="dimmed">请通过导航访问训练记录、动作库与客观统计。</Text>
          <Button component={Link} to="/">
            返回总览
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
export function App() {
  return (
    <AppShell
      header={{ height: 72 }}
      // Mobile uses bottom navigation, not an expanded full-width AppShell navbar.
      // Explicit collapse also excludes the exact sm boundary from mobile styles.
      navbar={{ width: 230, breakpoint: 'sm', collapsed: { mobile: true } }}
      padding={{ base: 'md', sm: 'xl' }}
    >
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <AppShell.Header>
        <Group h="100%" px={{ base: 'md', sm: 'xl' }} justify="space-between">
          <Group gap="sm">
            <ThemeIcon size={38}>
              <IconActivity size={24} />
            </ThemeIcon>
            <Text fw={800} size="lg">
              HealthWorker
            </Text>
          </Group>
          <Badge variant="light">本地开发 · M2–M4</Badge>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md">
        <Text size="xs" c="dimmed" px="sm" mb="md">
          个人训练空间
        </Text>
        {navigation.map((item) => (
          <NavLink
            key={item.path}
            component={RouterNavLink}
            to={item.path}
            end={item.path === '/'}
            label={item.label}
            leftSection={<item.icon size={20} />}
            className="desktop-nav"
          />
        ))}
        <NavLink
          component={RouterNavLink}
          to="/exercises"
          label="动作库"
          className="desktop-nav"
        />
        <Text c="dimmed" size="xs" mt="auto" p="sm">
          只记录与客观统计，不提供医疗判断。
        </Text>
      </AppShell.Navbar>
      <AppShell.Main id="main-content" tabIndex={-1}>
        <Container size="lg">
          <Suspense fallback={<Text role="status">正在加载页面…</Text>}>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/workouts" element={<WorkoutHistory />} />
              <Route path="/workouts/new" element={<WorkoutEditorPage />} />
              <Route path="/workouts/:id" element={<WorkoutDetail />} />
              <Route
                path="/workouts/:id/edit"
                element={<WorkoutEditorPage />}
              />
              <Route path="/exercises" element={<ExerciseLibrary />} />
              <Route path="/trends" element={<Trends />} />
              <Route path="/settings" element={<Settings />} />
              <Route
                path="*"
                element={
                  <Placeholder
                    title="页面尚未开放"
                    description="此路径不存在，请通过导航返回训练。"
                  />
                }
              />
            </Routes>
          </Suspense>
        </Container>
      </AppShell.Main>
      <nav className="mobile-nav" aria-label="主要导航">
        {navigation.map((item) => (
          <RouterNavLink key={item.path} to={item.path} end={item.path === '/'}>
            <item.icon size={21} />
            <span>{item.label}</span>
          </RouterNavLink>
        ))}
      </nav>
    </AppShell>
  );
}
