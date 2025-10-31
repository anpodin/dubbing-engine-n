import fsPromises from 'fs/promises';

type PathLike = Parameters<typeof fsPromises.access>[0];

export const pathExists = async (target: PathLike): Promise<boolean> => {
  try {
    await fsPromises.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

export const safeUnlink = async (target?: PathLike | null): Promise<void> => {
  if (!target) return;

  try {
    await fsPromises.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
};

export const ensureDir = async (dirPath: PathLike): Promise<void> => {
  await fsPromises.mkdir(dirPath, { recursive: true });
};
